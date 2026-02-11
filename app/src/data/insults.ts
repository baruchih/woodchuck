// Insult Sword Fighting data from The Secret of Monkey Island
// "You fight like a dairy farmer!" - "How appropriate. You fight like a cow."

export interface InsultPair {
  insult: string;
  comeback: string;
}

// Classic pirate insults - the insult and correct comeback pairs
export const PIRATE_INSULTS: InsultPair[] = [
  {
    insult: "You fight like a dairy farmer!",
    comeback: "How appropriate. You fight like a cow.",
  },
  {
    insult: "I've spoken with apes more polite than you.",
    comeback: "I'm glad to hear you attended your family reunion.",
  },
  {
    insult: "Soon you'll be wearing my sword like a shish kebab!",
    comeback: "First you'd better stop waving it like a feather duster.",
  },
  {
    insult: "People fall at my feet when they see me coming.",
    comeback: "Even BEFORE they smell your breath?",
  },
  {
    insult: "I once owned a dog that was smarter than you.",
    comeback: "He must have taught you everything you know.",
  },
  {
    insult: "You make me want to puke.",
    comeback: "You make me think somebody already did.",
  },
  {
    insult: "Nobody's ever drawn blood from me and nobody ever will.",
    comeback: "You run THAT fast?",
  },
  {
    insult: "Have you stopped wearing diapers yet?",
    comeback: "Why, did you want to borrow one?",
  },
  {
    insult: "I got this scar on my face during a mighty struggle!",
    comeback: "I hope now you've learned to stop picking your nose.",
  },
  {
    insult: "I've heard you are a contemptible sneak.",
    comeback: "Too bad no one's ever heard of YOU at all.",
  },
  {
    insult: "You're no match for my brains, you poor fool.",
    comeback: "I'd be in real trouble if you ever used them.",
  },
  {
    insult: "My handkerchief will wipe up your blood!",
    comeback: "So you got that job as a janitor, after all.",
  },
];

// The Sword Master (Carla) uses the same insults but requires different comebacks!
// This is the twist from the original game - you have to learn new responses.
export const SWORD_MASTER_COMEBACKS: Record<string, string> = {
  "You fight like a dairy farmer!": "I am rubber, you are glue.",
  "I've spoken with apes more polite than you.":
    "I'm glad to hear you attended your family reunion.",
  "Soon you'll be wearing my sword like a shish kebab!":
    "First you'd better stop waving it like a feather duster.",
  "People fall at my feet when they see me coming.":
    "Even BEFORE they smell your breath?",
  "I once owned a dog that was smarter than you.":
    "He must have taught you everything you know.",
  "You make me want to puke.": "You make me think somebody already did.",
  "Nobody's ever drawn blood from me and nobody ever will.":
    "You run THAT fast?",
  "Have you stopped wearing diapers yet?":
    "Why, did you want to borrow one?",
  "I got this scar on my face during a mighty struggle!":
    "I hope now you've learned to stop picking your nose.",
  "I've heard you are a contemptible sneak.":
    "Too bad no one's ever heard of YOU at all.",
  "You're no match for my brains, you poor fool.":
    "I'd be in real trouble if you ever used them.",
  "My handkerchief will wipe up your blood!":
    "So you got that job as a janitor, after all.",
};

// Pirate names for random opponents
export const PIRATE_NAMES = [
  "Captain Smirk",
  "Bloody Bart",
  "One-Eyed Pete",
  "Barnacle Bill",
  "Scurvy Steve",
  "Crusty Chris",
  "Moldy Mike",
  "Rancid Ralph",
  "Grimy Greg",
  "Fetid Fred",
];

// The Sword Master's name
export const SWORD_MASTER_NAME = "Carla the Sword Master";

// localStorage keys
export const STORAGE_KEYS = {
  learnedInsults: "insult-sword-fight-learned",
  pirateWins: "insult-sword-fight-wins",
  swordMasterDefeated: "insult-sword-fight-sword-master-defeated",
};

// Game constants
export const POINTS_TO_WIN = 3;
export const INSULTS_TO_UNLOCK_SWORD_MASTER = 8;
