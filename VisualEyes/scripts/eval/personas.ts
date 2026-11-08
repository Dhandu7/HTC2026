// Made-up users for testing how well suggestions follow a person's profile and writing style.
// Each has training sentences (imported as "writing samples") and held-out test sentences
// the model never sees, so we measure prediction on new things that person would say.

export interface Persona {
  id: string;
  name: string;
  about: string;
  people: string[];
  /** Imported as writing samples (what a carer would paste in). */
  train: string[];
  /** Held out: sentences typed during the test. */
  test: string[];
  /** How to recognise this person's style in a suggestion. */
  style: { lowercase: boolean; punctuation: boolean; markers: string[] };
}

export const PERSONAS: Persona[] = [
  {
    id: "jordan",
    name: "Jordan",
    about: "19, college student. Big into basketball (Raptors fan) and video games, especially Fortnite. Texts super casually, all lowercase, lots of slang.",
    people: ["Maya", "Dev", "Coach Ray"],
    style: { lowercase: true, punctuation: false, markers: ["u", "ur", "lol", "nah", "gonna", "wanna", "im", "rn", "tmrw", "yo", "bro", "kinda", "idk"] },
    train: [
      "yo can u tell maya to grab my charger",
      "nah im good just tired lol",
      "dev u coming over tonight or nah",
      "did the raptors win last night",
      "im kinda hungry rn can we get pizza",
      "bro this game is so laggy",
      "can u turn the volume up a bit",
      "maya stop stealing my hoodies lol",
      "im gonna play fortnite with dev later",
      "tell coach ray i said whats up",
      "idk what time it is my phone died",
      "can u put the game on the big tv",
      "lol that was actually so funny",
      "im not tired yet can i stay up",
      "yo pass me my headphones",
      "the raptors gotta fix their defense fr",
      "can dev sleep over this weekend",
      "my back kinda hurts can u move me",
      "wanna watch a movie tonight",
      "thx for helping me out today",
    ],
    test: [
      "maya can u bring my headphones",
      "im gonna take a nap for a bit",
      "dev did u see the game last night",
      "can u get me some water rn",
      "yo turn the tv on pls",
      "the raptors are actually so bad lol",
      "tell coach ray im watching the game",
      "can we order pizza tonight",
    ],
  },
  {
    id: "margaret",
    name: "Margaret",
    about: "72, retired high school English teacher. Loves her garden (roses and tomatoes), crossword puzzles and her grandchildren. Writes properly, in full sentences with good punctuation, warm and a little formal.",
    people: ["Harold", "Lucy", "Ben", "Nurse Amara"],
    style: { lowercase: false, punctuation: true, markers: ["would", "please", "kindly", "rather", "dear", "thank you", "lovely", "shall"] },
    train: [
      "Harold, would you kindly open the window? It is rather stuffy in here.",
      "Thank you, dear. That was very thoughtful of you.",
      "Could you please check whether the tomatoes need watering?",
      "I would love to see Lucy and Ben this weekend.",
      "The roses are looking lovely this year.",
      "Nurse Amara, I am feeling a little uncomfortable this morning.",
      "Would you read the crossword clues to me, please?",
      "Please tell Ben I am very proud of him.",
      "I shall have a cup of tea, thank you.",
      "It is rather cold in here. May I have another blanket?",
      "Harold, did you remember to call the pharmacy?",
      "What a lovely surprise to see you both.",
      "Lucy, how was your piano recital?",
      "I am rather tired now. I think I shall rest.",
      "Could you move my pillow up a little, please?",
      "The garden needs some attention before the frost.",
      "Thank you for your patience with me today.",
      "Nurse Amara, could I have my medication now?",
      "Please do not fuss, I am quite all right.",
      "Would you put on some music, dear?",
    ],
    test: [
      "Could you please bring me a glass of water?",
      "Harold, would you check on the roses today?",
      "I would like to speak with Nurse Amara, please.",
      "Thank you, dear. I am feeling much better now.",
      "Please tell Lucy I loved her drawing.",
      "It is rather bright in here. Could you close the curtains?",
      "Would you help me with the crossword this afternoon?",
      "I shall need my reading glasses, please.",
    ],
  },
  {
    id: "sam",
    name: "Sam",
    about: "45, dad of two, has ALS. Lifelong Oilers fan, loves hockey and barbecue. Dry sense of humour. Writes casually but with normal punctuation.",
    people: ["Priya", "Leo", "Ava", "Biscuit"],
    style: { lowercase: false, punctuation: true, markers: ["hockey", "oilers", "game", "priya", "leo", "ava", "biscuit"] },
    train: [
      "Priya, can you put the Oilers game on?",
      "Leo, how did practice go today?",
      "Tell Ava I'm proud of her.",
      "Biscuit needs to go out, he's been staring at me.",
      "I'm fine, just tired. Don't worry about me.",
      "Can you fire up the barbecue this weekend?",
      "The Oilers need a better power play.",
      "Priya, I love you. Thanks for everything today.",
      "Can you scratch my nose? It's driving me crazy.",
      "Leo, did you finish your homework?",
      "Ava, show me your science project.",
      "Who's winning the game?",
      "I could really go for a burger right now.",
      "Can you move my legs a bit? They're stiff.",
      "Biscuit, stop barking at the mailman.",
      "Let's watch the game together tonight.",
      "Can you turn the heat down a little?",
      "Priya, can you call my brother later?",
      "That ref needs glasses.",
      "I'm getting tired, can we call it a night?",
    ],
    test: [
      "Priya, can you turn the game up?",
      "Leo, how was school today?",
      "Can you take Biscuit for a walk?",
      "The Oilers are playing tonight.",
      "Ava, I'm proud of you.",
      "Can you get me some water please?",
      "I'm tired, I think I need a nap.",
      "Can we have a barbecue on Saturday?",
    ],
  },
];
