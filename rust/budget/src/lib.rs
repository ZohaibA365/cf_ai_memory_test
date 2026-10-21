//! Token-budget enforcement for the memory experiment.
//!
//! Every model call, in every memory design, may carry at most the same number
//! of estimated tokens (the system prompt, memory, search results, history and
//! tool definitions together). This crate holds the counting rules and decides
//! which history messages fit. The Worker calls it through WebAssembly
//! (`src/memory/budget-wasm-glue.ts`).
//!
//! It must give exactly the same answers as the TypeScript code it replaced,
//! or the reported results would no longer describe the code:
//!
//! - **Inputs are lengths in UTF-16 code units.** The estimator was
//!   `Math.ceil(text.length / 4)`, and JavaScript's `length` counts UTF-16 code
//!   units ("é" is 1, "😀" is 2). The Worker passes `text.length` for each
//!   text, which JavaScript already stores, so nothing is transcoded. (A first
//!   version passed the text as UTF-8 and recounted the units here. Encoding
//!   every message on every call made the budget step 8× slower than the
//!   TypeScript it replaced, and a UTF-8 byte count, Rust's `str::len()`,
//!   would have been wrong for any non-ASCII text. See SUMMARY.md.)
//! - **Budget arithmetic is `f64`,** like a JavaScript number, so comparisons
//!   with any budget (fractional, zero, negative, NaN, infinite) behave the
//!   same way. Token counts are integers far below 2^53, so sums are exact.

/// Tokens added per message for its role and framing.
pub const MESSAGE_OVERHEAD_TOKENS: f64 = 4.0;

/// Estimated tokens for a text of `units` UTF-16 code units: about 4
/// characters per token, rounded up (`Math.ceil(length / 4)`).
pub fn text_tokens(units: u32) -> f64 {
    u64::from(units).div_ceil(4) as f64
}

/// Estimated tokens for one message: its text plus the per-message overhead.
pub fn message_tokens(units: u32) -> f64 {
    text_tokens(units) + MESSAGE_OVERHEAD_TOKENS
}

/// One history message as the budget sees it.
#[derive(Clone, Copy, Debug)]
pub struct Message {
    /// Length of the message's text in UTF-16 code units.
    pub units: u32,
    /// A tool result. It must never be the first message of the window, or
    /// the model would see a result without the call that produced it.
    pub is_tool_result: bool,
}

/// What [`fit_to_budget`] keeps.
#[derive(Debug, PartialEq)]
pub struct Fit {
    /// Index of the first kept message; the window is `messages[start..]`.
    pub start: usize,
    /// Estimated tokens for the system prompt, tools and kept messages.
    pub estimated_tokens: f64,
}

/// Drops the oldest messages until system prompt + tools + messages fit the
/// budget.
///
/// Walks from the newest message back and stops at the first one that does
/// not fit, so the window is always a contiguous run of the newest messages.
/// The newest message is always kept, so a turn can never be emptied: if the
/// system prompt and that one message alone exceed the budget, the result is
/// over budget and `estimated_tokens` says by how much. Then a tool result
/// left at the front of the window is dropped as well, unless it is the only
/// message.
pub fn fit_to_budget(
    system_units: u32,
    messages: &[Message],
    tool_tokens: f64,
    budget: f64,
) -> Fit {
    fit(
        system_units,
        messages.len(),
        |i| messages[i].units,
        |i| messages[i].is_tool_result,
        tool_tokens,
        budget,
    )
}

/// The one implementation of the walk, over accessors, so the library API
/// (a slice of [`Message`]) and the WebAssembly API (two flat arrays) share it.
fn fit(
    system_units: u32,
    count: usize,
    units: impl Fn(usize) -> u32,
    is_tool_result: impl Fn(usize) -> bool,
    tool_tokens: f64,
    budget: f64,
) -> Fit {
    let mut used = text_tokens(system_units) + tool_tokens;
    let mut start = count;
    for i in (0..count).rev() {
        let cost = message_tokens(units(i));
        let kept_any = start < count;
        if kept_any && used + cost > budget {
            break;
        }
        start = i;
        used += cost;
    }
    while count - start > 1 && is_tool_result(start) {
        used -= message_tokens(units(start));
        start += 1;
    }
    Fit {
        start,
        estimated_tokens: used,
    }
}

/// The WebAssembly interface: plain `extern "C"` functions.
///
/// No wasm-bindgen: numbers cross directly, and the per-message lengths and
/// flags go through a buffer the JavaScript side gets from [`budget_alloc`].
/// Token counts and budgets are `f64` at the boundary (a JavaScript number);
/// lengths are `u32` (a JavaScript string is far shorter than 2^32 code units).
pub mod ffi {
    use super::*;
    use std::alloc::{alloc, dealloc, Layout};

    /// Alignment of every buffer handed to JavaScript: enough for the `f64`
    /// result slot and the `u32` length table.
    const ALIGN: usize = 8;

    fn layout(len: usize) -> Layout {
        Layout::from_size_align(len.max(1), ALIGN).expect("buffer too large")
    }

    /// Allocates `len` bytes of linear memory for JavaScript to fill.
    /// Returns 0 if the allocation fails.
    #[no_mangle]
    pub extern "C" fn budget_alloc(len: usize) -> *mut u8 {
        // SAFETY: the layout has a non-zero size.
        unsafe { alloc(layout(len)) }
    }

    /// Frees a buffer from [`budget_alloc`].
    ///
    /// # Safety
    /// `ptr` must come from `budget_alloc(len)`, with the same `len`, and not
    /// have been freed already.
    #[no_mangle]
    pub unsafe extern "C" fn budget_free(ptr: *mut u8, len: usize) {
        if !ptr.is_null() {
            dealloc(ptr, layout(len));
        }
    }

    /// [`text_tokens`] for a text of `units` UTF-16 code units.
    #[no_mangle]
    pub extern "C" fn budget_text_tokens(units: u32) -> f64 {
        text_tokens(units)
    }

    /// [`message_tokens`] for a message text of `units` UTF-16 code units.
    #[no_mangle]
    pub extern "C" fn budget_message_tokens(units: u32) -> f64 {
        message_tokens(units)
    }

    /// [`fit_to_budget`] over `count` messages, given as their lengths
    /// (`lens_ptr`, `count` × u32 UTF-16 code units) and tool-result flags
    /// (`flags_ptr`, `count` × u8, 1 = tool result).
    ///
    /// Returns the index of the first kept message and writes the estimated
    /// tokens to `*out_tokens`. Allocates nothing, so memory cannot grow during
    /// the call and the JavaScript side's views of it stay valid.
    ///
    /// # Safety
    /// `lens_ptr` and `flags_ptr` must be readable for `count` elements (any
    /// pointer if `count` is 0); `out_tokens` must be writable and 8-byte
    /// aligned.
    #[no_mangle]
    pub unsafe extern "C" fn budget_fit(
        system_units: u32,
        lens_ptr: *const u32,
        flags_ptr: *const u8,
        count: usize,
        tool_tokens: f64,
        budget: f64,
        out_tokens: *mut f64,
    ) -> u32 {
        let lens = slice(lens_ptr, count);
        let flags = slice(flags_ptr, count);
        let fit = fit(
            system_units,
            count,
            |i| lens[i],
            |i| flags[i] != 0,
            tool_tokens,
            budget,
        );
        *out_tokens = fit.estimated_tokens;
        fit.start as u32
    }

    /// A slice from a raw pointer, allowing a null or dangling pointer when
    /// `len` is 0 (JavaScript passes offset 0 for empty arrays).
    unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
        if len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(ptr, len)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(units: u32) -> Message {
        Message {
            units,
            is_tool_result: false,
        }
    }

    fn tool(units: u32) -> Message {
        Message {
            units,
            is_tool_result: true,
        }
    }

    #[test]
    fn text_tokens_round_up_quarter_length() {
        assert_eq!(text_tokens(0), 0.0);
        assert_eq!(text_tokens(1), 1.0);
        assert_eq!(text_tokens(4), 1.0);
        assert_eq!(text_tokens(5), 2.0);
        assert_eq!(text_tokens(u32::MAX), 1_073_741_824.0); // no overflow
    }

    #[test]
    fn message_tokens_add_the_overhead() {
        assert_eq!(message_tokens(0), 4.0);
        assert_eq!(message_tokens(8), 6.0);
    }

    #[test]
    fn keeps_the_newest_messages_that_fit() {
        // 36 units = 9 + 4 = 13 tokens per message; a 3-unit system prompt = 1.
        let messages = [msg(36); 10];
        let fit = fit_to_budget(3, &messages, 0.0, 40.0);
        // 1 + 13 + 13 + 13 = 40 fits exactly; a fourth message would not.
        assert_eq!(
            fit,
            Fit {
                start: 7,
                estimated_tokens: 40.0
            }
        );
    }

    #[test]
    fn stops_at_the_first_message_that_does_not_fit() {
        // A long message in the middle blocks older short ones: the window is
        // contiguous, it does not skip ahead to fit smaller messages.
        let messages = [msg(4), msg(4), msg(400), msg(4)];
        let fit = fit_to_budget(0, &messages, 0.0, 20.0);
        assert_eq!(
            fit,
            Fit {
                start: 3,
                estimated_tokens: 5.0
            }
        );
    }

    #[test]
    fn counts_tools_and_system_against_the_budget() {
        let messages = [msg(36); 10];
        let plain = fit_to_budget(0, &messages, 0.0, 60.0);
        let heavy = fit_to_budget(40, &messages, 10.0, 60.0);
        assert!(heavy.start > plain.start);
        assert!(heavy.estimated_tokens <= 60.0);
    }

    #[test]
    fn never_drops_the_newest_message() {
        let fit = fit_to_budget(0, &[msg(10_000)], 0.0, 100.0);
        assert_eq!(
            fit,
            Fit {
                start: 0,
                estimated_tokens: 2504.0
            }
        );
    }

    #[test]
    fn drops_a_tool_result_left_at_the_front() {
        let messages = [msg(400), tool(2), msg(5)];
        // Room for the tool result and the last message, not the long one.
        let budget = message_tokens(2) + message_tokens(5);
        let fit = fit_to_budget(0, &messages, 0.0, budget);
        assert_eq!(
            fit,
            Fit {
                start: 2,
                estimated_tokens: message_tokens(5)
            }
        );
    }

    #[test]
    fn drops_several_leading_tool_results() {
        let messages = [tool(2), tool(2), msg(5)];
        assert_eq!(fit_to_budget(0, &messages, 0.0, 2000.0).start, 2);
    }

    #[test]
    fn keeps_a_lone_tool_result() {
        assert_eq!(fit_to_budget(0, &[tool(2)], 0.0, 0.0).start, 0);
    }

    #[test]
    fn empty_history_costs_only_the_fixed_part() {
        let fit = fit_to_budget(8, &[], 3.0, 2000.0);
        assert_eq!(
            fit,
            Fit {
                start: 0,
                estimated_tokens: 5.0
            }
        );
    }

    #[test]
    fn budget_comparisons_follow_javascript_numbers() {
        let messages = [msg(4), msg(4)]; // 5 tokens each
                                         // Fractional budget: 10 > 9.5, so only the newest message fits.
        assert_eq!(fit_to_budget(0, &messages, 0.0, 9.5).start, 1);
        // NaN: `used + cost > NaN` is false in JavaScript, so nothing is dropped.
        assert_eq!(fit_to_budget(0, &messages, 0.0, f64::NAN).start, 0);
        // Negative and -Infinity budgets still keep the newest message.
        assert_eq!(fit_to_budget(0, &messages, 0.0, -5.0).start, 1);
        assert_eq!(fit_to_budget(0, &messages, 0.0, f64::NEG_INFINITY).start, 1);
        assert_eq!(fit_to_budget(0, &messages, 0.0, f64::INFINITY).start, 0);
        // Fractional tool tokens carry through to the estimate.
        assert_eq!(
            fit_to_budget(0, &messages, 0.5, 2000.0).estimated_tokens,
            10.5
        );
    }

    #[test]
    fn ffi_fit_matches_the_library_function() {
        let cases: &[(&[u32], &[u8], f64)] = &[
            (&[], &[], 2000.0),
            (&[10, 2, 30], &[0, 1, 0], 2000.0),
            (&[400, 2, 5], &[0, 1, 0], 11.0),
            (&[36; 10], &[0; 10], 40.0),
            (&[4, 4], &[0, 0], f64::NAN),
        ];
        for (lens, flags, budget) in cases {
            let messages: Vec<Message> = lens
                .iter()
                .zip(*flags)
                .map(|(&units, &f)| Message {
                    units,
                    is_tool_result: f != 0,
                })
                .collect();
            let expected = fit_to_budget(7, &messages, 1.5, *budget);
            let mut out = 0.0;
            let start = unsafe {
                ffi::budget_fit(
                    7,
                    lens.as_ptr(),
                    flags.as_ptr(),
                    lens.len(),
                    1.5,
                    *budget,
                    &mut out,
                )
            };
            assert_eq!(
                (start as usize, out),
                (expected.start, expected.estimated_tokens),
                "{lens:?} {budget}"
            );
        }
        assert_eq!(ffi::budget_text_tokens(12), 3.0);
        assert_eq!(ffi::budget_message_tokens(0), 4.0);
    }

    #[test]
    fn ffi_alloc_and_free() {
        use ffi::*;
        let ptr = budget_alloc(64);
        assert!(!ptr.is_null());
        assert_eq!(ptr as usize % 8, 0);
        unsafe { budget_free(ptr, 64) };
        let empty = budget_alloc(0);
        assert!(!empty.is_null());
        unsafe { budget_free(empty, 0) };
    }
}
