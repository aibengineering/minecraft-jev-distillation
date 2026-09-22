export type Score = {
  accuracy: number; majorityBaseline: number; macroF1: number; logLoss: number;
  classes: Record<string, number>; rows: number;
};
export type Dependence = {
  key: string; label: string; unit: string; eligibleRows: number; sampledRows: number;
  grid: number[]; probabilities: Record<string, number[]>;
  categories?: Record<string, string>;
};
export type ModelAnalysis = {
  modelSha256: string; trainedAt: string; rows: number; runs: number;
  heads: Record<string, {
    score: Score; totalSplits: number;
    importance: { key: string; count: number; share: number }[];
    pdps: Dependence[];
  }>;
};

export const FEATURE_LABELS: Record<string, string> = {
  e0_lookAngle: "A · looking toward the bot", e0_shotDegIfFaced: "A · incoming shot angle",
  e1_shotDegIfFaced: "B · incoming shot angle", e0_hurtAgo: "A · time since last hit",
  b_hurtAgo: "Bot · time since last hit", e0_absAngle: "A · bearing from the bot",
  e1_absAngle: "B · bearing from the bot", e2_absAngle: "C · bearing from the bot",
  e0_releaseIn: "A · bow release countdown", e1_releaseIn: "B · bow release countdown",
  p_move: "Previous movement", n_facedFdist: "Facing target · forecast distance",
  b_swordReadyIn: "Sword cooldown", b_speed: "Bot speed", e0_reachNow: "A · sword reach distance",
  n_nearestMeleeDist: "Nearest melee enemy distance", e0_dist: "A · distance",
  e0_closing: "A · closing speed", p_pace: "Previous pace", g_ahead_kind: "Ground ahead",
  p_jump: "Previous jump", e0_angle: "A · signed bearing", w_behind_right: "Wall behind-right",
  w_behind: "Wall behind", n_bombImminent: "Imminent creeper explosion", n_maxFuse: "Highest creeper fuse",
};

// Selected for interpretable contrasts after inspecting the model, not as an
// exhaustive ranking of effects. Each PDP still varies exactly one column.
export const PDP_FEATURES: Record<string, { key: string; unit: string; integer?: boolean; categories?: Record<string, string> }[]> = {
  face: [{ key: "e0_shotDegIfFaced", unit: "degrees from facing enemy A" }],
  hands: [{ key: "b_swordReadyIn", unit: "ticks until sword ready", integer: true }],
  jump: [{ key: "g_ahead_kind", unit: "ground ahead", categories: { 0: "Open floor", 1: "Wall", 2: "Step up", 3: "1-block drop", 4: "2-block drop", 5: "Deeper drop", 6: "Lava", 7: "Water", 8: "Magma" } }],
};
