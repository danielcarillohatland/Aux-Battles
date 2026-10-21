/**
 * Round prompts (D-029). The host picks a VIBE; the room gets one short scene
 * from it that everyone understands instantly and feels something about.
 * Rules for every line: one image, direct, no setup paragraph, 5-14 words.
 *
 * Soundtrack test: every scene must be a moment where music plays, or should
 * play (a film scene, a montage, an entrance, a car with the volume up). Three
 * players should each think of a different song at once and argue about who is
 * right. Pure conversations, physical discomfort, and moments with no soundtrack
 * fail. Awkward scenes are welcome when the music is part of the cringe.
 *
 * Every scene carries a `vibe`: the one feeling the song must create, shown to
 * the whole room and handed to the judge as the brief. It removes the guessing
 * (is the music stopping mid-dance romantic or mortifying?) so everyone, and
 * the AI, scores against the same target. Keep it short and unambiguous.
 */
export interface Scenario {
  /** The moment itself (5-14 words). */
  scene: string;
  /** The agreed feeling the song should give this moment (3-10 words). */
  vibe: string;
}

export interface ScenarioTheme {
  id: string;
  name: string;
  emoji: string;
  /** One-line hint on the host's picker chip. */
  tagline: string;
  scenarios: readonly Scenario[];
}

export const SCENARIO_THEMES: readonly ScenarioTheme[] = [
  {
    id: 'hype',
    name: 'Hype',
    emoji: '🔥',
    tagline: 'Adrenaline, montages, big entrances',
    scenarios: [
      {
        scene: 'Training montage for a one-year-old football prodigy.',
        vibe: 'Ridiculously epic, like this baby is the next Messi.',
      },
      {
        scene: 'Walking away from a huge explosion in slow motion.',
        vibe: 'Untouchable main-character cool, you did not even flinch.',
      },
      {
        scene: 'Your pre-workout just kicked in at the gym.',
        vibe: 'Pure aggression, you could lift a car right now.',
      },
      {
        scene: 'Entering the ring for the biggest fight of your life.',
        vibe: 'Walk-out swagger, intimidating and unstoppable.',
      },
      {
        scene: 'Last minute of the final, your team is down by one.',
        vibe: 'Unbearable tension, every heartbeat counts.',
      },
      {
        scene: 'Sprinting through the airport to catch the last flight.',
        vibe: 'Frantic, sweaty, against-the-clock panic.',
      },
      {
        scene: 'The underdog team runs out of the tunnel.',
        vibe: 'Goosebumps underdog pride, nobody believed in you.',
      },
      {
        scene: 'Getting ready with the boys before the big night out.',
        vibe: 'Hyped and invincible, tonight is going to be legendary.',
      },
      {
        scene: 'Boss fight music for beating your little brother at FIFA.',
        vibe: 'Absurdly epic, as if the world depends on this match.',
      },
      {
        scene: 'Doors open at the club and you walk in first.',
        vibe: 'Dramatic VIP entrance, all eyes on you.',
      },
      {
        scene: 'You have to floor it to make the last ferry.',
        vibe: 'Reckless adrenaline, foot down, no regrets.',
      },
      {
        scene: 'A car explodes behind you as you put on your sunglasses.',
        vibe: 'Untouchable main-character cool, explosions are just background.',
      },
    ],
  },
  {
    id: 'feel-good',
    name: 'Feel-Good',
    emoji: '☀️',
    tagline: 'Sunshine, road trips, everyone singing',
    scenarios: [
      {
        scene: 'Road trip banger everyone in the car can sing along to.',
        vibe: 'Carefree joy, everyone screaming the chorus together.',
      },
      {
        scene: 'Vacation music while the plane lifts off towards the Bahamas.',
        vibe: 'Pure vacation freedom, worries left on the runway.',
      },
      {
        scene: 'First warm day of the year, windows down.',
        vibe: 'Lighthearted sunshine, spring finally won.',
      },
      {
        scene: 'The whole kitchen dancing while making Sunday pancakes.',
        vibe: 'Silly, wholesome family joy.',
      },
      {
        scene: 'Friday 4 pm, laptop closed, weekend starts now.',
        vibe: 'Pure relief, freedom, the weekend is yours.',
      },
      {
        scene: 'Barbecue on the balcony and the sun refuses to set.',
        vibe: 'Lazy golden-hour happiness that never ends.',
      },
      {
        scene: 'Convertible, coastal road, no plans until Monday.',
        vibe: 'Breezy luxury freedom, hair in the wind.',
      },
      {
        scene: 'The crew reunites at the airport after a year apart.',
        vibe: 'Overwhelming joy, hugs and screaming.',
      },
      {
        scene: 'Last day of school, backpacks thrown in the air.',
        vibe: "Wild school's-out euphoria.",
      },
      {
        scene: 'Walking out of the exam knowing you passed.',
        vibe: 'Smug relief, you are a genius.',
      },
      {
        scene: 'Payday, sunglasses on, the good grocery store.',
        vibe: 'Rich for one day, strutting like a millionaire.',
      },
      {
        scene: 'Pool party at 3 pm and someone brought a speaker.',
        vibe: 'Messy, sunny party chaos.',
      },
    ],
  },
  {
    id: 'sad-hours',
    name: 'Sad Hours',
    emoji: '💔',
    tagline: 'Heartbreak, goodbyes, 2 am feelings',
    scenarios: [
      {
        scene: 'Watching your ex’s stories at 2 am for no reason.',
        vibe: 'Pathetic heartache you would never admit to.',
      },
      {
        scene: 'Last night before your best friend moves abroad.',
        vibe: 'Bittersweet goodbye, trying not to cry.',
      },
      {
        scene: 'Driving home after getting dumped in a parking lot.',
        vibe: 'Raw heartbreak with the volume way too loud.',
      },
      {
        scene: 'Your childhood dog’s last walk.',
        vibe: 'Devastating, quiet farewell, tissues needed.',
      },
      {
        scene: 'Packing up your first apartment for the very last time.',
        vibe: 'Nostalgic and bittersweet, a chapter closing.',
      },
      {
        scene: 'Rain on the bus window, headphones in, nobody texting back.',
        vibe: 'Lonely melancholy, the world feels grey.',
      },
      {
        scene: 'Deleting the photos you said you already deleted.',
        vibe: 'Painful letting-go, you still miss them.',
      },
      {
        scene: 'Grandma’s house is sold and the key does not fit anymore.',
        vibe: 'Deep nostalgic grief for a lost childhood.',
      },
      {
        scene: 'Sitting on the kitchen floor eating cereal at midnight.',
        vibe: 'Numb, lonely, 2 am emptiness.',
      },
      {
        scene: 'The airport goodbye where neither of you turns around.',
        vibe: 'Heartbreaking, silent goodbye.',
      },
      {
        scene: 'Last song at the school dance, and they danced with someone else.',
        vibe: 'Crushing jealousy and hopeless longing.',
      },
      {
        scene: 'Everyone leaves the party and you do the dishes alone.',
        vibe: 'Lonely aftermath, the fun is over.',
      },
    ],
  },
  {
    id: 'awkward',
    name: 'Awkward',
    emoji: '😬',
    tagline: 'Cringe, secondhand embarrassment, oh no',
    scenarios: [
      {
        scene: 'Wannabe rapper releases his very first song.',
        vibe: 'Painfully cringe, he thinks he is a legend.',
      },
      {
        scene: 'Elevator music while stuck with your boss after calling in sick.',
        vibe: 'Excruciatingly awkward small-talk silence.',
      },
      {
        scene: 'Your parents walk in while your date playlist is still playing.',
        vibe: 'Mortifying, you want the floor to swallow you.',
      },
      {
        scene: 'Slow dance at the wedding and nobody knows the steps.',
        vibe: 'Clumsy, sweet second-hand embarrassment.',
      },
      {
        scene: 'Walk-on music for presenting to the whole company with your fly open.',
        vibe: 'Confident walk-on, completely unaware of the disaster.',
      },
      {
        scene: 'Your Spotify starts blasting at full volume in a silent library.',
        vibe: 'Mortifying, everyone is staring at you.',
      },
      {
        scene: 'Your mom plays your secret emo playlist at the family dinner.',
        vibe: 'Exposed, the whole family hears your teen angst.',
      },
      {
        scene: 'Slow-dancing with your crush when the song suddenly ends.',
        vibe: 'Painfully awkward, the silence is deafening.',
      },
      {
        scene: 'The DJ plays your breakup song at your ex’s wedding.',
        vibe: 'Excruciating, the worst possible song at the worst time.',
      },
      {
        scene: 'Your phone connects to the party speaker and plays your guilty pleasure.',
        vibe: 'Exposed, your secret taste is out.',
      },
      {
        scene: 'Your gym crush watches you fail a bench press, in slow motion.',
        vibe: 'Tragic slow-motion failure in front of your crush.',
      },
      {
        scene: 'A silent car ride after your dad hears your Spotify Wrapped.',
        vibe: 'Silent shame, your taste has been judged.',
      },
    ],
  },
  {
    id: 'comedy',
    name: 'Pure Comedy',
    emoji: '🤡',
    tagline: 'Absurd, ridiculous, laugh-out-loud',
    scenarios: [
      {
        scene: 'A goose chases you across the entire park.',
        vibe: 'Chaotic panic, run for your life.',
      },
      {
        scene: 'Grown man sobbing through the birthday song at a five-year-old’s party.',
        vibe: 'Ridiculous over-the-top sobbing.',
      },
      {
        scene: 'Your uncle’s karaoke encore that nobody asked for.',
        vibe: 'Cringe performance nobody can escape.',
      },
      {
        scene: 'Running late for the wedding in Crocs.',
        vibe: 'Comic panic, sprinting in the wrong shoes.',
      },
      {
        scene: 'Wedding first dance, but the DJ hits play on the wrong song.',
        vibe: 'Hilariously wrong mood for a romantic moment.',
      },
      {
        scene: 'A pigeon steals your kebab and flies off in slow motion.',
        vibe: 'Tragic, overly dramatic loss.',
      },
      {
        scene: 'Walking into a formal gala dressed as a pirate.',
        vibe: 'Absurd confidence in the wrong outfit.',
      },
      {
        scene: 'The cat knocks the birthday cake off the table in slow motion.',
        vibe: 'Comic tragedy, the party is ruined.',
      },
      {
        scene: 'Your GPS drives you into a lake and the music keeps playing.',
        vibe: 'Absurd, carefree, the vibes stay unbothered.',
      },
      {
        scene: 'Grandpa discovers TikTok dances at Christmas dinner.',
        vibe: 'Cringe-hilarious, grandpa thinks he is viral.',
      },
      {
        scene: 'Your dad tries to parallel park with the whole family watching.',
        vibe: 'Unbearable tension, a high-stakes mission.',
      },
      {
        scene: 'The toddler grabs the mic and starts singing during the wedding speech.',
        vibe: 'Chaotic and adorable, the speech is hijacked.',
      },
    ],
  },
  {
    id: 'cinematic',
    name: 'Movie Moment',
    emoji: '🎬',
    tagline: 'Big screen, trailer energy, final scenes',
    scenarios: [
      {
        scene: 'The villain finally reveals the master plan.',
        vibe: 'Sinister and theatrical, pure evil genius.',
      },
      {
        scene: 'Driving through the desert at sunset, top down.',
        vibe: 'Free and cinematic, endless open road.',
      },
      {
        scene: 'The hero gets up from the dust one more time.',
        vibe: 'Triumphant comeback, rising against all odds.',
      },
      {
        scene: 'Final scene, credits roll over an empty beach.',
        vibe: 'Peaceful, emotional ending.',
      },
      {
        scene: 'The heist crew walks in slow motion towards the bank.',
        vibe: 'Cool and confident, the plan is perfect.',
      },
      {
        scene: 'First kiss in the rain after the big argument.',
        vibe: 'Swelling romance, passion after the storm.',
      },
      {
        scene: 'The spaceship leaves Earth for the last time.',
        vibe: 'Epic, emotional farewell to everything.',
      },
      {
        scene: 'Opening scene: a small town where nothing ever happens.',
        vibe: 'Quiet, dreamy, something is about to change.',
      },
      {
        scene: 'The car chase through the narrow streets of Rome.',
        vibe: 'Fast, chaotic, high-speed thrills.',
      },
      {
        scene: 'Two old enemies meet again at the funeral.',
        vibe: 'Tense and loaded, old wounds reopen.',
      },
      {
        scene: 'The detective connects the final clue at 3 am.',
        vibe: 'Eerie, brilliant, the mystery cracks.',
      },
      {
        scene: 'Prom night, and the outsider walks in transformed.',
        vibe: 'Jaw-dropping glow-up, everyone turns around.',
      },
    ],
  },
  {
    id: 'villain',
    name: 'Villain Era',
    emoji: '😈',
    tagline: 'Petty, powerful, unbothered',
    scenarios: [
      {
        scene: 'Walking out of the courtroom after winning, sunglasses on.',
        vibe: 'Smug and unbeatable, justice served cold.',
      },
      {
        scene: 'Walking into the party your ex said would be small.',
        vibe: 'Petty glamour, you are the main event.',
      },
      {
        scene: 'Quitting your job mid-shift and leaving through the front door.',
        vibe: 'Liberated and reckless, no notice given.',
      },
      {
        scene: 'Your ex got engaged and you have never looked better.',
        vibe: 'Glowing revenge, living your best life.',
      },
      {
        scene: 'Blocking everyone who doubted you, one by one.',
        vibe: 'Cold, calm, satisfying power.',
      },
      {
        scene: 'Sitting front row at your rival’s failed launch.',
        vibe: 'Smug, petty, delicious schadenfreude.',
      },
      {
        scene: 'Strolling past your coworker’s desk with the promotion they bragged about.',
        vibe: 'Petty victory lap, every step a statement.',
      },
      {
        scene: 'Driving off after the breakup, windows down, volume maxed.',
        vibe: 'Liberating rage, singing at the top of your lungs.',
      },
      {
        scene: 'Arriving at the reunion in a car you did not need.',
        vibe: 'Show-off flex, unnecessarily rich.',
      },
      {
        scene: 'Slow-motion walk into your ex’s wedding, completely uninvited.',
        vibe: 'Dramatic chaos, you came to ruin the day.',
      },
      {
        scene: 'Strutting out of the salon after the breakup haircut.',
        vibe: 'Reborn and fabulous, a new you.',
      },
      {
        scene: 'Moving day, blasting the music your landlord banned for two years.',
        vibe: 'Rebellious freedom, finally loud.',
      },
    ],
  },
  {
    id: 'throwback',
    name: 'Throwback',
    emoji: '📼',
    tagline: 'Childhood, school discos, old summers',
    scenarios: [
      {
        scene: 'The song from your first school disco.',
        vibe: 'Innocent, awkward, first-party excitement.',
      },
      {
        scene: 'Summer 2009, speaker in a plastic cup at the beach.',
        vibe: 'Carefree teen summer, sand and bad decisions.',
      },
      {
        scene: 'Game Boy in the back seat on the way to grandma.',
        vibe: 'Bored but cozy childhood car-ride nostalgia.',
      },
      {
        scene: 'Your first phone finally gets a ringtone.',
        vibe: 'Proud and slightly embarrassing early-2000s tech flex.',
      },
      {
        scene: 'Friday night pizza with the music video channel on full blast.',
        vibe: 'Cozy weekend nostalgia, no responsibilities.',
      },
      {
        scene: 'The school bus on the last day before summer.',
        vibe: 'Wild excitement, summer starts now.',
      },
      {
        scene: 'Your older sibling’s mixtape you were not allowed to touch.',
        vibe: 'Forbidden cool, the music you were too young for.',
      },
      {
        scene: 'Sleepover at 1 am with the lights off.',
        vibe: 'Giggly, secret, late-night mischief.',
      },
      {
        scene: 'First slow dance, hands sweating, no idea where to look.',
        vibe: 'Nervous, sweet, first-crush awkwardness.',
      },
      {
        scene: 'The song that played in every shop the summer you turned twelve.',
        vibe: 'Inescapable earworm nostalgia.',
      },
      {
        scene: 'Downloading one song on dial-up overnight, praying nobody picks up the phone.',
        vibe: 'Painfully slow, worth it, peak 2000s.',
      },
      {
        scene: 'Your family’s road trip cassette on repeat.',
        vibe: 'Warm family nostalgia, everyone knows every word.',
      },
    ],
  },
] as const;

/** Sentinel the host sends to get a random vibe. */
export const SURPRISE_THEME_ID = 'surprise';

export function findScenarioTheme(idOrName: string): ScenarioTheme | undefined {
  const needle = idOrName.trim().toLowerCase();
  return SCENARIO_THEMES.find(
    (theme) => theme.id === needle || theme.name.toLowerCase() === needle,
  );
}
