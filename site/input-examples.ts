// Examples for the captured creeper/skeleton frame. Related summary features
// change together, using the definitions in src/sense/features.ts.
export const INPUT_EXAMPLES: {
  title: string; description: string; head: string; choice: string;
  edits: Record<string, number>;
}[] = [
  {
    title: "Move forward",
    description: "Creeper fuse: 29 → 10 ticks",
    head: "move", choice: "forward",
    edits: { e0_fuse: 10, n_maxFuse: 10, n_bombImminent: 0 },
  },
  {
    title: "Face the skeleton",
    description: "Bow releases in: 6 → 1 tick",
    head: "face", choice: "1",
    edits: { e1_releaseIn: 1, n_minReleaseIn: 1, n_archerFiresWithinWindow: 1, n_minShotTicks: 1, n_minArrival: 6 },
  },
];
