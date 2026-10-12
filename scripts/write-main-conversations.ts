// Writes the 20 main-split test conversations (data/conversations/main-*.json)
// from the specs below. Each conversation plants seven messages: a simple
// fact, two exact details, a fact that later changes, and a two-part fact
// whose second message refers to the person only indirectly, so no single
// message answers the combine question. The two "never said" questions ask
// about an unmentioned detail of something that was mentioned (harder than
// asking about something absent altogether). No message asks to be saved.
// No model calls; re-run after editing a spec.
//
//   npm run write:conversations

import { writeFileSync } from "node:fs";
import type { Conversation, QuestionType } from "../src/experiment/conversation";
import { conversationSchema } from "../src/experiment/conversation";

const PLANT_GAP = 12; // filler pairs after each planted message (same as the seeds)
const ASK_GAP = 8; // filler pairs before each question

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Accepted spellings of a date: "April 9", "9 April", "9 of April". Numeric
 * forms ("4/9") are left out: they falsely match ranges like "2-3" in small
 * talk, and the model rarely answers that way.
 */
function date(month: string, day: number): string[] {
  if (!MONTHS.includes(month)) throw new Error(`bad month ${month}`);
  return [`${month} ${day}`, `${day} ${month}`, `${day} of ${month}`];
}

interface Spec {
  title: string;
  /** Planted messages, in order: simple, exact1, old, partA, exact2, change, partB. */
  simple: string;
  exact1: string;
  old: string;
  partA: string;
  exact2: string;
  change: string;
  partB: string;
  q: {
    simple: [string, string[]];
    exact1: [string, string[]];
    exact2: [string, string[]];
    changed: [string, string[], string[]];
    combine: [string, string[][]];
    never: [string, string[]][];
  };
}

const SPECS: Spec[] = [
  {
    title: "A new puppy and a kitchen remodel",
    simple: "We adopted a puppy last month and named her Juniper.",
    exact1: "The quote for our kitchen remodel came in at $18,400.",
    old: "I drive a blue Honda Civic to work.",
    partA: "Our next-door neighbor is called Odile.",
    exact2: "Juniper's first vet appointment is on April 9.",
    change: "I finally sold the Civic. I drive a Subaru Outback now.",
    partB: "Our next-door neighbor is lending us her tile saw for the remodel.",
    q: {
      simple: ["What's my puppy's name?", ["Juniper"]],
      exact1: ["How much was the quote for the kitchen remodel?", ["18400", "18 400"]],
      exact2: ["When is Juniper's first vet appointment?", date("April", 9)],
      changed: ["What car do I drive?", ["Subaru", "Outback"], ["Civic"]],
      combine: ["What is our next-door neighbor called, and what is she lending us?", [["Odile"], ["tile saw"]]],
      never: [["What breed is my puppy?", ["Juniper"]], ["What color are the new kitchen cabinets?", []]]
    }
  },
  {
    title: "Night classes and a new apartment",
    simple: "I'm learning Portuguese at a night class on Tuesdays.",
    exact1: "My student ID for the class is 552-019.",
    old: "I live in a studio apartment on Elm Street.",
    partA: "My teacher at the night class is Mr. Okafor.",
    exact2: "The final exam for the class is on December 2.",
    change: "I signed a lease on a two-bedroom on Harbor Road and moved in last weekend.",
    partB: "My teacher assigned us a short story by Clarice Lispector.",
    q: {
      simple: ["What language am I learning?", ["Portuguese"]],
      exact1: ["What's my student ID for the class?", ["552019", "552 019"]],
      exact2: ["When is the final exam for my class?", date("December", 2)],
      changed: ["What street do I live on?", ["Harbor Road", "Harbor Rd"], ["Elm Street", "Elm St"]],
      combine: ["Who is my teacher, and which author did they assign?", [["Okafor"], ["Lispector"]]],
      never: [["What time does my Tuesday class start?", []], ["What's my teacher's first name?", ["Okafor"]]]
    }
  },
  {
    title: "Planning a wedding",
    simple: "My partner and I are getting married, and the venue is a vineyard called Larkspur Hill.",
    exact1: "We've invited 112 guests.",
    old: "The wedding is set for September 20.",
    partA: "My best man is my cousin Rafael.",
    exact2: "The deposit for the caterer was $2,750.",
    change: "We had to move the wedding to October 11.",
    partB: "My best man is flying in from Lima the day before.",
    q: {
      simple: ["What's the name of our wedding venue?", ["Larkspur Hill", "Larkspur"]],
      exact1: ["How many guests have we invited?", ["112"]],
      exact2: ["How much was the deposit for the caterer?", ["2750", "2 750"]],
      changed: ["What's the date of our wedding?", date("October", 11), date("September", 20)],
      combine: ["Who is my best man, and where is he flying in from?", [["Rafael"], ["Lima"]]],
      never: [["What's my partner's name?", ["Rafael"]], ["What is the caterer serving at the wedding?", []]]
    }
  },
  {
    title: "Knee rehab and running",
    simple: "I'm seeing a physical therapist, Dr. Banks, for my knee.",
    exact1: "My therapist wants me doing 3 sets of 22 leg raises every day.",
    old: "I go to the gym on Westbrook Avenue.",
    partA: "My running buddy is Ines.",
    exact2: "My next appointment with Dr. Banks is on May 27.",
    change: "I switched gyms; I go to the one on Calder Street now.",
    partB: "My running buddy just signed us both up for a 10K in Porto.",
    q: {
      simple: ["What's my physical therapist's name?", ["Banks"]],
      exact1: ["How many leg raises per set am I supposed to do?", ["22"]],
      exact2: ["When is my next appointment with Dr. Banks?", date("May", 27)],
      changed: ["Which street is my gym on?", ["Calder Street", "Calder"], ["Westbrook"]],
      combine: ["Who is my running buddy, and where is the race she signed us up for?", [["Ines"], ["Porto"]]],
      never: [["What's Dr. Banks's first name?", ["Banks"]], ["How did I hurt my knee?", []]]
    }
  },
  {
    title: "A trip to Vietnam",
    simple: "I'm planning a trip to Vietnam in the spring.",
    exact1: "My passport number ends in 7731.",
    old: "I booked a hostel in Hanoi for the first week.",
    partA: "My travel buddy is my coworker Linnea.",
    exact2: "My flight to Hanoi departs on February 16.",
    change: "I cancelled the hostel and booked an Airbnb in Hanoi instead.",
    partB: "My coworker is bringing her drone to film the trip.",
    q: {
      simple: ["Which country am I traveling to?", ["Vietnam"]],
      exact1: ["What are the last four digits of my passport number?", ["7731"]],
      exact2: ["When does my flight to Hanoi depart?", date("February", 16)],
      changed: ["Where am I staying in Hanoi?", ["Airbnb"], ["hostel"]],
      combine: ["Who is my travel buddy, and what is she bringing to film the trip?", [["Linnea"], ["drone"]]],
      never: [["Which airline am I flying to Hanoi?", []], ["How long is my whole trip?", []]]
    }
  },
  {
    title: "Starting a new job",
    simple: "I just started a new job at a company called Brightwater Labs.",
    exact1: "My employee badge number is 40312.",
    old: "My manager is named Gwen.",
    partA: "I carpool to work with a colleague named Haruto.",
    exact2: "My first performance review is on July 8.",
    change: "Gwen left the company, so my new manager is Tobias.",
    partB: "The colleague I carpool with lives in Maplewood.",
    q: {
      simple: ["What company do I work for?", ["Brightwater"]],
      exact1: ["What's my employee badge number?", ["40312"]],
      exact2: ["When is my first performance review?", date("July", 8)],
      changed: ["Who is my manager?", ["Tobias"], ["Gwen"]],
      combine: ["Who do I carpool with, and where does he live?", [["Haruto"], ["Maplewood"]]],
      never: [["What's my job title?", []], ["What does Brightwater Labs make?", []]]
    }
  },
  {
    title: "A daughter at elementary school",
    simple: "My daughter goes to Linden Park Elementary.",
    exact1: "Her school's office number is 555-0143.",
    old: "My daughter's best friend is a girl named Sadie.",
    partA: "Her teacher this year is Ms. Delacroix.",
    exact2: "My daughter's birthday is November 23.",
    change: "Update on the friend front: my daughter's best friend is Amara now.",
    partB: "Her teacher is taking the class to the aquarium next Friday.",
    q: {
      simple: ["What school does my daughter go to?", ["Linden Park"]],
      exact1: ["What's the phone number of my daughter's school office?", ["5550143", "555 0143"]],
      exact2: ["When is my daughter's birthday?", date("November", 23)],
      changed: ["Who is my daughter's best friend?", ["Amara"], ["Sadie"]],
      combine: ["What's my daughter's teacher's name, and where is she taking the class?", [["Delacroix"], ["aquarium"]]],
      never: [["What's my daughter's name?", ["Amara", "Sadie"]], ["What instrument does my daughter play?", []]]
    }
  },
  {
    title: "A balcony garden",
    simple: "I grow tomatoes and basil on my balcony.",
    exact1: "My balcony is 14 square meters.",
    old: "I keep my bike in the hallway of my building.",
    partA: "My landlord is Mr. Petrov.",
    exact2: "My rent is $1,365 a month.",
    change: "I moved my bike out of the hallway; it lives in the basement storage now.",
    partB: "My landlord is replacing the balcony railing next month.",
    q: {
      simple: ["What herb do I grow on my balcony?", ["basil"]],
      exact1: ["How big is my balcony?", ["14"]],
      exact2: ["How much is my rent?", ["1365"]],
      changed: ["Where do I keep my bike?", ["basement"], ["hallway"]],
      combine: ["Who is my landlord, and what is he replacing?", [["Petrov"], ["railing"]]],
      never: [["What color is my bike?", []], ["What's my landlord's first name?", ["Petrov"]]]
    }
  },
  {
    title: "Piano lessons",
    simple: "I've started taking piano lessons.",
    exact1: "My lessons cost $45 an hour.",
    old: "My lessons are on Wednesday evenings.",
    partA: "My piano teacher is named Clementine.",
    exact2: "My first recital is on March 2.",
    change: "My teacher moved my lessons to Saturday mornings.",
    partB: "My piano teacher is holding her student recital at the community center.",
    q: {
      simple: ["What instrument am I learning?", ["piano"]],
      exact1: ["How much do my lessons cost per hour?", ["45"]],
      exact2: ["When is my first recital?", date("March", 2)],
      changed: ["When are my piano lessons?", ["Saturday"], ["Wednesday"]],
      combine: ["What's my piano teacher's name, and where is her recital?", [["Clementine"], ["community center", "community centre"]]],
      never: [["What piece am I playing at the recital?", []], ["How long have I been playing piano?", []]]
    }
  },
  {
    title: "A car accident claim",
    simple: "My car insurance is with a company called Halvard Mutual.",
    exact1: "My claim number is 88-4512.",
    old: "My car is at a repair shop called Duffy's.",
    partA: "The other driver's name was Marguerite.",
    exact2: "The adjuster is inspecting my car on August 19.",
    change: "Duffy's couldn't fix it, so the car went to Kesler Auto.",
    partB: "The other driver's insurance is covering my rental car.",
    q: {
      simple: ["Which company is my car insurance with?", ["Halvard"]],
      exact1: ["What's my claim number?", ["884512", "88 4512"]],
      exact2: ["When is the adjuster inspecting my car?", date("August", 19)],
      changed: ["Which repair shop has my car?", ["Kesler"], ["Duffy's", "Duffys"]],
      combine: ["What was the other driver's name, and what is her insurance covering?", [["Marguerite"], ["rental"]]],
      never: [["What model is my car?", []], ["How much is the repair going to cost?", []]]
    }
  },
  {
    title: "Hosting a book club",
    simple: "I host a book club called the Tuesday Readers.",
    exact1: "There are 23 members in the book club.",
    old: "This month we're reading Middlemarch.",
    partA: "The newest member of the book club is Bartholomew.",
    exact2: "Our next meeting is on January 14.",
    change: "We dropped Middlemarch and switched to The Remains of the Day.",
    partB: "Our newest member offered to host next month's meeting at his bakery.",
    q: {
      simple: ["What's my book club called?", ["Tuesday Readers"]],
      exact1: ["How many members are in my book club?", ["23"]],
      exact2: ["When is our next book club meeting?", date("January", 14)],
      changed: ["Which book are we reading this month?", ["Remains of the Day"], ["Middlemarch"]],
      combine: ["Who is our newest member, and where will next month's meeting be?", [["Bartholomew"], ["bakery"]]],
      never: [["What's the name of Bartholomew's bakery?", []], ["How long has the book club been running?", []]]
    }
  },
  {
    title: "Volunteering at a shelter",
    simple: "I volunteer at an animal shelter on weekends.",
    exact1: "I've logged 63 volunteer hours this year.",
    old: "At the shelter I mostly walk the dogs.",
    partA: "The shelter coordinator is Yusuf.",
    exact2: "The shelter's adoption fair is on April 26.",
    change: "They moved me from dog walking to the cat room.",
    partB: "The shelter coordinator asked me to run the adoption fair.",
    q: {
      simple: ["Where do I volunteer on weekends?", ["animal shelter", "shelter"]],
      exact1: ["How many volunteer hours have I logged this year?", ["63"]],
      exact2: ["When is the shelter's adoption fair?", date("April", 26)],
      changed: ["What do I do at the shelter now?", ["cat room", "cats"], ["walk the dogs", "dog walking", "walking the dogs"]],
      combine: ["Who is the shelter coordinator, and what did he ask me to run?", [["Yusuf"], ["adoption fair"]]],
      never: [["What's the name of the shelter?", []], ["Which animal at the shelter is my favorite?", []]]
    }
  },
  {
    title: "A Thai cooking class",
    simple: "I'm taking a Thai cooking class.",
    exact1: "The whole course costs $320.",
    old: "The class meets at a community kitchen in Riverside.",
    partA: "My cooking partner in class is Fumiko.",
    exact2: "Our final cook-off is on June 21.",
    change: "They moved the class to a restaurant kitchen in Oakmont.",
    partB: "My cooking partner is allergic to cilantro.",
    q: {
      simple: ["What kind of cooking class am I taking?", ["Thai"]],
      exact1: ["How much does the whole cooking course cost?", ["320"]],
      exact2: ["When is our final cook-off?", date("June", 21)],
      changed: ["Where does my cooking class meet?", ["Oakmont"], ["Riverside"]],
      combine: ["Who is my cooking partner, and what is she allergic to?", [["Fumiko"], ["cilantro"]]],
      never: [["What dish am I making for the final cook-off?", []], ["What's the instructor's name?", ["Fumiko"]]]
    }
  },
  {
    title: "Visiting a grandfather",
    simple: "My grandfather lives in a care home called Willow Court.",
    exact1: "His room number is 214.",
    old: "I visit him every Sunday.",
    partA: "His nurse at Willow Court is Benedikt.",
    exact2: "His birthday is on October 4.",
    change: "Work got in the way, so I switched my visits to Thursdays.",
    partB: "His nurse taught him to make video calls on a tablet.",
    q: {
      simple: ["What's the name of my grandfather's care home?", ["Willow Court"]],
      exact1: ["What's my grandfather's room number?", ["214"]],
      exact2: ["When is my grandfather's birthday?", date("October", 4)],
      changed: ["Which day do I visit my grandfather?", ["Thursday", "Thursdays"], ["Sunday", "Sundays"]],
      combine: ["What's my grandfather's nurse called, and what did he teach him?", [["Benedikt"], ["video call", "video calls"]]],
      never: [["What's my grandfather's name?", ["Benedikt"]], ["What was my grandfather's job before he retired?", []]]
    }
  },
  {
    title: "A side-project app",
    simple: "I'm building an app that tracks bus arrival times.",
    exact1: "The app has 1,240 beta users.",
    old: "I'm writing the app in Objective-C.",
    partA: "My cofounder is Valentina.",
    exact2: "We launch publicly on November 7.",
    change: "I rewrote the whole app in Kotlin.",
    partB: "My cofounder is pitching the app to an investor in Denver.",
    q: {
      simple: ["What does my app track?", ["bus"]],
      exact1: ["How many beta users does my app have?", ["1240"]],
      exact2: ["When does my app launch publicly?", date("November", 7)],
      changed: ["What programming language is my app written in?", ["Kotlin"], ["Objective-C", "Objective C"]],
      combine: ["Who is my cofounder, and where is she pitching the app?", [["Valentina"], ["Denver"]]],
      never: [["What's the name of my app?", []], ["How much money has my app raised?", []]]
    }
  },
  {
    title: "A cockatiel and a conference",
    simple: "I have a cockatiel named Pistachio.",
    exact1: "Pistachio is 13 years old.",
    old: "I buy his seed mix at a shop called Feathers & Co.",
    partA: "My bird sitter is my neighbor Corentin.",
    exact2: "My conference starts on May 12.",
    change: "Feathers & Co closed, so now I buy his seed mix at PetHaven.",
    partB: "My bird sitter is watching Pistachio while I'm at a conference in Montreal.",
    q: {
      simple: ["What's my cockatiel's name?", ["Pistachio"]],
      exact1: ["How old is my cockatiel?", ["13"]],
      exact2: ["When does my conference start?", date("May", 12)],
      changed: ["Where do I buy my cockatiel's seed mix?", ["PetHaven", "Pet Haven"], ["Feathers"]],
      combine: ["Who is my bird sitter, and where is my conference?", [["Corentin"], ["Montreal"]]],
      never: [["What color is Pistachio?", []], ["What is my conference about?", []]]
    }
  },
  {
    title: "Dental work",
    simple: "My dentist is Dr. Okonkwo.",
    exact1: "I need a crown on tooth number 26.",
    old: "My cleaning is booked at the Fairview clinic.",
    partA: "My dental hygienist is Priscilla.",
    exact2: "My crown appointment is on February 28.",
    change: "I moved my cleaning to their Lakeside clinic.",
    partB: "My dental hygienist recommended I switch to an electric toothbrush.",
    q: {
      simple: ["Who is my dentist?", ["Okonkwo"]],
      exact1: ["Which tooth needs a crown?", ["26"]],
      exact2: ["When is my crown appointment?", date("February", 28)],
      changed: ["Which clinic is my cleaning at?", ["Lakeside"], ["Fairview"]],
      combine: ["Who is my hygienist, and what did she recommend?", [["Priscilla"], ["electric toothbrush"]]],
      never: [["How much will my crown cost?", []], ["What's my dentist's first name?", ["Okonkwo"]]]
    }
  },
  {
    title: "A photography exhibition",
    simple: "I shoot film with a Leica M6.",
    exact1: "I've printed 27 photos for my exhibition.",
    old: "My exhibition is at Café Norte.",
    partA: "My mentor in the photography club is Anouk.",
    exact2: "The exhibition opens on September 5.",
    change: "The exhibition moved to the Greywell Gallery.",
    partB: "My mentor is driving me to a shoot in Big Sur next weekend.",
    q: {
      simple: ["What camera do I shoot with?", ["Leica"]],
      exact1: ["How many photos have I printed for my exhibition?", ["27"]],
      exact2: ["When does my exhibition open?", date("September", 5)],
      changed: ["Where is my photo exhibition?", ["Greywell"], ["Cafe Norte", "Norte"]],
      combine: ["Who is my mentor, and where is the shoot she's driving me to?", [["Anouk"], ["Big Sur"]]],
      never: [["What's the theme of my exhibition?", []], ["Which lens do I use most?", []]]
    }
  },
  {
    title: "Bouldering",
    simple: "I've gotten really into bouldering.",
    exact1: "My climbing gym membership is $72 a month.",
    old: "I climb at a gym called Crux.",
    partA: "My climbing partner is Zeynep.",
    exact2: "I wear size 41 climbing shoes.",
    change: "Crux closed, so I joined Summit Wall.",
    partB: "My climbing partner is planning a trip to Fontainebleau.",
    q: {
      simple: ["What sport have I gotten into?", ["bouldering", "climbing"]],
      exact1: ["How much is my climbing gym membership per month?", ["72"]],
      exact2: ["What size are my climbing shoes?", ["41"]],
      changed: ["Which climbing gym do I go to?", ["Summit Wall"], ["Crux"]],
      combine: ["Who is my climbing partner, and where is she planning a trip?", [["Zeynep"], ["Fontainebleau"]]],
      never: [["What grade do I climb?", []], ["What brand are my climbing shoes?", []]]
    }
  },
  {
    title: "Freelance design",
    simple: "I do freelance logo design.",
    exact1: "My hourly rate is $85.",
    old: "My biggest client is a coffee roaster called Ember & Oak.",
    partA: "My accountant is Leopold.",
    exact2: "My portfolio site gets about 3,800 visits a month.",
    change: "Ember & Oak ended our contract; my biggest client now is Northgate Cycles.",
    partB: "My accountant says I can deduct my new laptop as a business expense.",
    q: {
      simple: ["What kind of freelance work do I do?", ["logo", "logos"]],
      exact1: ["What's my hourly rate?", ["85"]],
      exact2: ["About how many visits does my portfolio site get a month?", ["3800"]],
      changed: ["Who is my biggest client?", ["Northgate"], ["Ember & Oak", "Ember and Oak", "Ember"]],
      combine: ["Who is my accountant, and what did he say I can deduct?", [["Leopold"], ["laptop"]]],
      never: [["What design software do I use?", []], ["How long have I been freelancing?", []]]
    }
  }
];

// Question order is rotated per conversation so no question type always
// comes first (or last).
const ORDER: (QuestionType | "never2")[] = ["simple", "never", "exact", "changed", "exact2", "combine", "never2"] as never;

function build(spec: Spec, n: number): Conversation {
  const id = `main-${String(n).padStart(2, "0")}`;
  const says = [
    { id: "simple", text: spec.simple, purpose: "plant" as const },
    { id: "exact1", text: spec.exact1, purpose: "plant" as const },
    { id: "old", text: spec.old, purpose: "plant" as const },
    { id: "part-a", text: spec.partA, purpose: "plant" as const },
    { id: "exact2", text: spec.exact2, purpose: "plant" as const },
    { id: "change", text: spec.change, purpose: "change" as const },
    { id: "part-b", text: spec.partB, purpose: "plant" as const }
  ];
  const q = spec.q;
  const asks = {
    simple: { id: "q-simple", question: q.simple[0], type: "simple", expected: [q.simple[1]], outdated: [], dependsOn: ["simple"] },
    exact: { id: "q-exact1", question: q.exact1[0], type: "exact", expected: [q.exact1[1]], outdated: [], dependsOn: ["exact1"] },
    exact2: { id: "q-exact2", question: q.exact2[0], type: "exact", expected: [q.exact2[1]], outdated: [], dependsOn: ["exact2"] },
    changed: { id: "q-changed", question: q.changed[0], type: "changed", expected: [q.changed[1]], outdated: q.changed[2], dependsOn: ["old", "change"] },
    combine: { id: "q-combine", question: q.combine[0], type: "combine", expected: q.combine[1], outdated: [], dependsOn: ["part-a", "part-b"] },
    never: { id: "q-never1", question: q.never[0][0], type: "never", expected: [], outdated: q.never[0][1], dependsOn: [] },
    never2: { id: "q-never2", question: q.never[1][0], type: "never", expected: [], outdated: q.never[1][1], dependsOn: [] }
  } as const;
  const rotate = (n - 1) % ORDER.length;
  const order = [...ORDER.slice(rotate), ...ORDER.slice(0, rotate)];

  const steps: Conversation["steps"] = [];
  for (const s of says) {
    steps.push({ kind: "say", ...s });
    steps.push({ kind: "filler", pairs: PLANT_GAP });
  }
  for (const key of order) {
    if (steps.at(-1)?.kind !== "filler") steps.push({ kind: "filler", pairs: ASK_GAP });
    steps.push({ kind: "ask", ...(asks[key as keyof typeof asks] as object) } as never);
    steps.push({ kind: "filler", pairs: ASK_GAP });
  }
  steps.pop();
  return conversationSchema.parse({ id, title: spec.title, split: "main", steps });
}

SPECS.forEach((spec, i) => {
  const c = build(spec, i + 1);
  writeFileSync(`data/conversations/${c.id}.json`, JSON.stringify(c, null, 2) + "\n");
});
console.log(`Wrote ${SPECS.length} main conversations.`);
