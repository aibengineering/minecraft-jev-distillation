/**
 * The reader for our LightGBM model file: the format ml/lgbm_json.py writes,
 * LightGBM's own `dump_model()` JSON pruned to the trees and leaf values, one
 * entry per question head. There is no LightGBM runtime for Bun, so the
 * trees are walked here, following LightGBM's missing-value routing, with
 * the softmax or sigmoid on top. Only what the trained models use is
 * implemented: numerical splits, multiclass and binary objectives.
 * `bun ml/verify.ts` checks every prediction against Python's own. No file
 * or platform dependency: the same code runs in the loop and in a browser.
 */
interface SplitNode {
  split_feature: number;
  threshold: number;
  decision_type: string;
  default_left: boolean;
  missing_type: "None" | "Zero" | "NaN";
  left_child: TreeNode;
  right_child: TreeNode;
}
interface LeafNode {
  leaf_value: number;
}
type TreeNode = SplitNode | LeafNode;

export interface DumpedModel {
  num_class: number;
  num_tree_per_iteration: number;
  objective: string;
  feature_names: string[];
  tree_info: { tree_index: number; tree_structure: TreeNode }[];
}

export interface HeadModel {
  classes: string[];
  objective: "multiclass" | "binary";
  model: DumpedModel;
}

export interface ModelFile {
  version: number;
  trainedAt: string;
  featureNames: string[];
  heads: Record<string, HeadModel>;
  meta: Record<string, unknown>;
}

function isLeaf(node: TreeNode): node is LeafNode {
  return "leaf_value" in node;
}

/** One tree's leaf value for a feature vector, following LightGBM's missing-value rules. */
function walk(node: TreeNode, x: Float64Array): number {
  while (!isLeaf(node)) {
    const value = x[node.split_feature]!;
    let goLeft: boolean;
    if (Number.isNaN(value)) {
      // With missing type "None" LightGBM treats NaN as zero; otherwise NaN takes the default branch.
      goLeft = node.missing_type === "None" ? 0 <= node.threshold : node.default_left;
    } else if (node.missing_type === "Zero" && value === 0) {
      goLeft = node.default_left;
    } else if (node.decision_type === "<=") {
      goLeft = value <= node.threshold;
    } else throw new Error(`unsupported decision type ${node.decision_type}`);
    node = goLeft ? node.left_child : node.right_child;
  }
  return node.leaf_value;
}

export class Predictor {
  readonly file: ModelFile;
  readonly #index: Map<string, number>;

  constructor(file: ModelFile) {
    this.file = file;
    this.#index = new Map(file.featureNames.map((name, i) => [name, i]));
  }

  get heads(): string[] {
    return Object.keys(this.file.heads);
  }

  /** The row in the model's feature order; features the model never saw are ignored, missing ones are NaN. */
  vector(row: Record<string, number>): Float64Array {
    const x = new Float64Array(this.file.featureNames.length).fill(NaN);
    for (const [name, value] of Object.entries(row)) {
      const i = this.#index.get(name);
      if (i !== undefined && value !== null) x[i] = value;
    }
    return x;
  }

  /** Class probabilities for one head. */
  predict(head: string, row: Record<string, number>): Record<string, number> {
    const spec = this.file.heads[head];
    if (!spec) throw new Error(`no model for head ${head}`);
    const x = this.vector(row);
    const model = spec.model;
    if (spec.objective === "binary") {
      let raw = 0;
      for (const tree of model.tree_info) raw += walk(tree.tree_structure, x);
      const p = 1 / (1 + Math.exp(-raw));
      return { [spec.classes[0]!]: 1 - p, [spec.classes[1]!]: p };
    }
    const k = model.num_class;
    const raw = new Array<number>(k).fill(0);
    for (const tree of model.tree_info) raw[tree.tree_index % k]! += walk(tree.tree_structure, x);
    const max = Math.max(...raw);
    const exp = raw.map((r) => Math.exp(r - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return Object.fromEntries(spec.classes.map((name, i) => [name, exp[i]! / sum]));
  }
}
