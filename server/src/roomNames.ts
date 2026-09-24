import { randomInt } from "node:crypto";

// Room names like "quiet-amber-otter-42": readable aloud, and with ~446 million
// combinations (~29 bits) hard to stumble onto by scanning. The name is the
// only thing keeping strangers out of a room, so don't shrink these lists much.
// Words are lowercase a-z, and no word appears in two lists. Words that could
// form unfortunate pairs (skin-tone colors, primates) are left out on purpose.

/** A mood or quality: the first word. */
export const MOODS = [
  "agile", "airy", "alert", "balmy", "blithe", "bold", "brave", "breezy", "bright", "brisk", "bubbly",
  "buoyant", "busy", "calm", "candid", "carefree", "cheeky", "cheery", "chill", "chirpy", "civil", "clever",
  "cosmic", "cozy", "crisp", "curious", "dainty", "dandy", "dapper", "daring", "deft", "dreamy", "eager",
  "early", "earnest", "easy", "elated", "epic", "fabled", "fair", "fancy", "fearless", "festive", "fiery",
  "fine", "fleet", "fluent", "fluffy", "fond", "frank", "free", "fresh", "frisky", "frosty", "funky",
  "gallant", "genial", "gentle", "giddy", "glad", "gleeful", "glossy", "graceful", "grand", "groovy", "happy",
  "hardy", "hazy", "hearty", "heroic", "honest", "hopeful", "humble", "hushed", "jaunty", "jazzy", "jolly",
  "jovial", "joyful", "jumpy", "keen", "kind", "kindly", "leafy", "limber", "lithe", "lively", "lofty",
  "loyal", "lucid", "lucky", "lunar", "mellow", "merry", "mighty", "mild", "misty", "modest", "nifty",
  "nimble", "noble", "patient", "peaceful", "peppy", "perky", "placid", "playful", "plucky", "poised",
  "polite", "prime", "proud", "pure", "quick", "quiet", "quirky", "radiant", "rapid", "rare", "ready",
  "regal", "restful", "rich", "robust", "rosy", "royal", "rustic", "savvy", "serene", "sharp", "shiny",
  "silent", "sincere", "sleek", "sleepy", "smart", "smooth", "snappy", "snug", "soft", "solar", "sonic",
  "spry", "starry", "steady", "stellar", "stoic", "stout", "sturdy", "suave", "sunny", "super", "sweet",
  "swift", "tender", "thrifty", "tidy", "tranquil", "true", "trusty", "upbeat", "vast", "vivid", "warm",
  "wavy", "wild", "windy", "wise", "witty", "zany", "zen", "zesty", "zippy", "brassy", "cheerful", "classic",
  "dazzling", "dusty", "eternal", "gilded", "humming", "lilting", "lyric", "melodic", "mossy", "rhythmic",
  "sandy", "spirited", "tuneful", "twinkly", "velvety", "vibrant", "whistling",
];

/** A color, material, or texture: the second word. */
export const TONES = [
  "amber", "analog", "azure", "birch", "bronze", "cedar", "chalk", "cherry", "chrome", "cobalt", "cocoa",
  "copper", "coral", "cotton", "cream", "crimson", "crystal", "denim", "ebony", "emerald", "fern", "flint",
  "frost", "garnet", "ginger", "glass", "gold", "granite", "graphite", "hazel", "honey", "indigo", "ivory",
  "jade", "lemon", "lilac", "linen", "maple", "marble", "mint", "moss", "navy", "neon", "ochre", "olive",
  "onyx", "opal", "orchid", "paper", "pastel", "peach", "pearl", "pewter", "pine", "plum", "quartz", "rose",
  "ruby", "russet", "rust", "saffron", "sage", "salt", "sand", "satin", "scarlet", "sepia", "silk", "silver",
  "slate", "smoke", "snow", "stone", "straw", "suede", "sugar", "teal", "tin", "topaz", "tweed", "velvet",
  "vinyl", "violet", "walnut", "wheat", "willow", "wool", "acoustic", "aqua", "cinder", "clay", "cloud",
  "coffee", "cyan", "driftwood", "dune", "electric", "feather", "fog", "frosted", "glacier", "harbor", "ink",
  "iron", "lagoon", "lava", "lime", "marine", "meadow", "midnight", "mocha", "nectar", "oak", "oat", "ocean",
  "paisley", "pebble", "pepper", "pixel", "prism", "rainbow", "reef", "ripple", "shell", "sienna", "spruce",
  "steel", "storm", "sunset", "tangerine", "thistle", "tide", "twilight", "umber", "vanilla", "wax",
];

/** Animals, plants, places, instruments, and sky: the third word. */
export const NOUNS = [
  "otter", "heron", "badger", "beaver", "bison", "bobcat", "crane", "crow", "deer", "dolphin", "eagle",
  "egret", "falcon", "ferret", "finch", "fox", "gecko", "goose", "hare", "hawk", "hedgehog", "ibis", "jaguar",
  "koala", "lark", "lemur", "leopard", "lion", "llama", "lynx", "magpie", "marmot", "marten", "mink", "mole",
  "moose", "moth", "newt", "ocelot", "orca", "osprey", "owl", "panda", "panther", "parrot", "pelican",
  "penguin", "pigeon", "plover", "puffin", "quail", "rabbit", "robin", "salmon", "seal", "sloth", "sparrow",
  "squid", "stork", "swallow", "swan", "tapir", "tiger", "toad", "trout", "turtle", "walrus", "whale", "wolf",
  "wombat", "wren", "yak", "zebra", "bee", "beetle", "cricket", "firefly", "cicada", "acorn", "aspen",
  "bamboo", "basil", "bramble", "cactus", "clover", "daisy", "fig", "iris", "ivy", "juniper", "kelp", "lily",
  "lotus", "lupine", "magnolia", "mango", "poppy", "reed", "sequoia", "thyme", "tulip", "bay", "brook",
  "canyon", "cove", "creek", "delta", "fjord", "glade", "glen", "grove", "hill", "island", "lake", "marsh",
  "mesa", "orchard", "prairie", "ridge", "river", "shore", "summit", "tundra", "valley", "banjo", "bass",
  "bell", "bongo", "cello", "chime", "chord", "cymbal", "drum", "fiddle", "flute", "guitar", "harp", "horn",
  "kazoo", "lute", "mandolin", "oboe", "organ", "piano", "sitar", "tuba", "ukulele", "viola", "violin",
  "comet", "meteor", "moon", "nebula", "planet", "star", "galaxy", "aurora", "breeze", "echo", "ember",
  "rain", "thunder", "wave", "zephyr", "anchor", "arrow", "beacon", "candle", "compass", "kite", "lantern",
  "rocket", "sail", "teapot", "album", "anthem", "ballad", "chorus", "encore", "groove", "melody", "record",
  "rhythm", "sonnet", "tempo", "tune", "verse", "waltz", "cadence",
];

const pick = (words: readonly string[]) => words[randomInt(words.length)]!;

/** A new room name, e.g. "quiet-amber-otter-42" (the number is always two digits). */
export function generateRoomName(): string {
  return `${pick(MOODS)}-${pick(TONES)}-${pick(NOUNS)}-${randomInt(10, 100)}`;
}
