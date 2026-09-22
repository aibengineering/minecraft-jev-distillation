/**
 * The prompt jev reads: the situation paragraph that opens the state, and
 * the five questions with their criteria. The text between them, the fight
 * itself, is built in src/sense/describe.ts from the same snapshot the
 * feature row is built from.
 */
import type { Window } from "../regime.ts";
import type { Question } from "./jev.ts";

export function situation(window: Window & { latencyMs: number }): string {
  const { lead, latencyMs } = window;
  const timing =
    window.regime === "latency"
      ? `The answer reaches the bot about ${lead} ticks (${latencyMs} ms) after this snapshot and holds until the next answer, so the state is forecast to that moment. `
      : `The answer takes effect at once and holds for ${window.hold} ticks, then the bot asks again with a fresh snapshot. `;
  return (
    "A Minecraft player is fighting one or more enemies with a sword and an off-hand shield. " +
    timing +
    "Tactics: hit a melee mob as it enters reach and step back in the same window so its swing misses, then step in again once the sword is ready. " +
    "The best strike lands from one to two and a half blocks: inside one block the mob shares the bot's space, a swing there barely knocks it back " +
    "and the shield cannot block it, so step back first and strike as it follows. " +
    "Keep space: retreating straight back ends in a corner where everything converges and backing is blocked. Circle instead, moving left or " +
    "right around the faced enemy, which keeps room behind, lines several mobs up so only one is in reach at a time, brings an archer into " +
    "the shield arc, and can put a wall between the bot and the archer. Use the arena rather than a corner of it. " +
    "a mob that just hit cannot hit again for about 20 ticks, and a swing before the sword is ready does little damage. Chase skeletons down instead. " +
    "The shield needs 5 ticks to become active, blocks arrows and melee from the front only, and slows the bot. " +
    "A creeper does not swing: within about 3 blocks of the bot its fuse lights and it explodes about 30 ticks later for heavy damage; " +
    "the fuse is a counter that climbs within 3 blocks and falls outside. It follows at walking speed, so backing off from a creeper on the bot's " +
    "heels gains nothing; but a sword hit knocks it out of range, and once it is out of range backing off keeps it there and the counter falls. " +
    "The blast hurts out to about 6 blocks, so out of fuse range is not out of the blast: with the fuse above 20, sprint away to 6 blocks or more. " +
    "Never walk toward a creeper with a high fuse and a cold sword. Priorities by cost: a creeper blast in reach costs 15 or more, an arrow " +
    "about 2, a zombie hit about 1.4; a lit creeper in reach is hit at once even if that means taking an arrow. " +
    "A blaze hovers in the air, is immune to fire, and shoots bursts of three fireballs that fly straight, cost about 3 each and set the " +
    "bot on fire for several seconds more; a raised shield facing it blocks fireballs, cover ends its line of sight, and it is struck when " +
    "it dips within sword reach. A wither skeleton is a tall melee mob whose hit also withers: damage over ten seconds that no shield " +
    "stops once applied, so its hits cost about three times a zombie's; keep it at sword's length and strike as it enters reach. " +
    "Magma burns whatever stands on it; water puts out fire at once. "
  );
}

/**
 * The five questions. The situation paragraph and the "right now" sentence
 * are in the state, sent once; each question carries only its own guidance
 * and criteria. Before this, every question repeated the situation, five
 * copies a window, and that was nearly half of every call's tokens.
 */
export function questions(labels: readonly { label: string; blurb: string }[]): Record<string, Question> {
  return {
    face: {
      type: "choice",
      instructions:
        "Which enemy should the bot face for this window? Whoever can hurt the bot soonest comes first: a melee mob in reach or entering it " +
        "this window swings before any drawn bow fires, and its hit is the one to prevent or answer; an archer is faced when its arrow or " +
        "release lands sooner than any melee swing, or when no melee mob is near. Facing decides who it can hit, what 'forward' means and what the shield covers: " +
        "a raised shield blocks only sources within 90 degrees of where the bot looks, and each option below says which incoming shots facing " +
        "that enemy would cover. Facing an archer for one window to take its arrow on the shield, then turning back, is often right. " +
        "Prefer whoever can hurt the bot soonest, then whoever is nearly dead. An arrow already in flight lands sooner than any drawn bow: " +
        "if one is predicted to hit from outside the arc, face the option that puts it inside, unless a strike is landing this window. " +
        "A bow that will fire from outside the arc must be faced before it releases: at five blocks its arrow arrives in three ticks, " +
        "too soon to turn or step once it is loosed. With several bows drawn, pick the facing that covers the most that fire soonest.",
      criteria: Object.fromEntries([...labels.map(({ label, blurb }) => [label, blurb]), ["keep", "Keep facing exactly as now"]]),
    },
    move: {
      type: "choice",
      instructions:
        "Which way should it move for this window, relative to the enemy it faces? Independent of what the hands do: " +
        "a strike happens the instant the answer lands, so 'back' with a strike is hit-and-step-back in one window. " +
        "Close to sword reach when the sword is ready. Back off only from a melee mob that is in reach or entering it this window: in the " +
        "window after a strike while the sword recharges, when its swing is due, or when it is overlapping the bot inside one block, so the " +
        "next strike lands from a block out and its knockback separates. A mob out of reach cannot hit; backing away from it or circling " +
        "it only kites it and the fight never ends. With the sword ready and nothing due to land, let it come or step in. " +
        "Measured over past fights: striking a zombie while walking forward got the bot hit in more than half of those windows; striking while " +
        "stepping back from one to two blocks was never hit. Against a melee mob, back is the move in any window the bot strikes. " +
        "Against a skeleton, keep closing. Sidestep to avoid arrows and explosions; never walk off a drop or into lava. " +
        "Circling only works if it continues: keep circling the same way as the last answer unless something changed (a wall or hazard " +
        "ahead on that side, an arrow line, a mob stepping into the path). Flipping between left and right each window cancels itself " +
        "and leaves the bot standing where it was. Circling is for keeping space and lining mobs up, not for avoiding the fight.",
      criteria: {
        forward: "Walk toward the faced enemy: the move when the faced mob is out of reach, the sword is ready and nothing is due to land",
        back: "Walk straight away from the faced enemy: for a mob in reach or entering it, never for one out of reach; only worth it with room behind, it invites a corner",
        left: "Circle to the left around the faced enemy: keeps space behind, lines mobs up, swings the shield arc, reaches cover; the usual way to avoid a hit when the room behind is short. Stay on this side once chosen",
        right: "Circle to the right around the faced enemy, the same purposes; pick the side with more room or the side that puts an archer in front, and stay on it once chosen",
        hold: "Stand still",
      },
    },
    hands: {
      type: "choice",
      instructions:
        "What should the bot do with its hands this window? The sword and the shield share the hands: a swing drops the shield for a couple " +
        "of ticks, and that is exactly when an arrow or a ready melee attack gets through. Weigh the swing against what is about to land.",
      criteria: {
        strike:
          "Shield down for this window and swing at the faced enemy the instant the answer lands. Right when the faced enemy will be in reach " +
          "but not overlapping the bot (one to two and a half blocks) when the answer lands and the sword is ready, unless an arrow is due, or a " +
          "bow will release before a lowered shield could be active again (about 17 ticks); except that a lit creeper in reach is struck regardless, " +
          "since its blast costs far more than any arrow. A swing at a mob inside one block barely knocks it " +
          "back: step back first. An archer in reach with the sword ready is struck, drawn bow or not: its arrow costs about 2, a strike takes a " +
          "third of its health and knocks it back, and guarding it point blank only takes arrow after arrow; guard in the cold windows " +
          "between strikes, and the best moment is right after it fires, but do not wait for it. The swing happens at once, before " +
          "any walking, so an enemy that is only in reach after walking forward is not a strike yet: the swing is wasted and the guard is down for " +
          "nothing. If the sword is cold the swing does little",
        guard:
          "Shield up the whole window, no swing. Right while closing on a melee mob that will not be in reach when the answer lands (approach " +
          "guarded, strike next window), when an arrow will hit inside the shield arc and the shield can be active by then, when the sword is not ready, or when more than " +
          "one melee mob will be in reach at once. A guard only blocks what is inside the shield arc of the enemy being faced; if the shot is " +
          "outside that arc, guarding is pointless unless the face answer turns toward the archer, and a shield that cannot be active before the " +
          "arrow lands blocks nothing either: then the answer is the sidestep the arrow line names. A shield does nothing against a creeper blast; " +
          "distance does",
        free: "Shield down and no swing: nothing within four blocks, no bow drawn, and the bot wants its full speed to close or get clear",
        cover:
          "Build cover: place a two-block column one block from the bot on the line of the archer that fires soonest, which ends its line of " +
          "fire until one of them moves, then raise the shield. The window is spent building, no swing. Right when two or more archers have " +
          "clear shots from directions one facing cannot cover, when an archer will fire from outside the arc and cannot be faced in time, " +
          "or to break a crossfire before closing on one archer; the Cover line in the facts names the archer a column would silence. " +
          "Needs cobblestone (the state says how many) and an archer with a line of sight; useless against melee mobs, which walk around it",
      },
    },
    pace: {
      type: "choice",
      instructions: "How fast should the bot move this window? Independent of what the hands do.",
      criteria: {
        sprint: "Sprint: closing a gap, chasing a skeleton, or getting clear fast",
        walk: "Walk: the normal pace for trading blows",
        sneak: "Sneak: only at the edge of a drop, since it is very slow",
      },
    },
    jump: {
      type: "noul",
      instructions: "Should the bot jump this window? Independent of everything else.",
      criteria: {
        true: "There is a one-block step to clear, or a jump would dodge something",
        false: "Flat ground and nothing to dodge; jumping only wastes time and hunger",
      },
    },
  };
}
