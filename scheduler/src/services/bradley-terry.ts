/**
 * bradley-terry.ts — Pure Bradley-Terry MAP solver for Oracle V3.
 *
 * Replaces V1/V2's single-fixture inversion (β=0.886 contamination) with a
 * simultaneous solve across all league fixtures in a rolling window.
 * Every team constrains every other team; errors average across the network.
 *
 * Algorithm: Newton-Raphson on MAP log-posterior with Gaussian prior.
 *   L(R) = Σ_m w_m × [ES_m × log(Ê_m) + (1-ES_m) × log(1-Ê_m)]
 *          - Σ_i (R_i - μ_i)² / (2σ²)
 *
 * Where:
 *   Ê_m = σ(R_home - R_away + H)   [Elo sigmoid]
 *   σ(x) = 1 / (1 + 10^(-x/400))
 *   μ_i = prior mean (B value) for team i
 *   σ   = prior std dev (ORACLE_V3_BT_SIGMA_PRIOR)
 *   w_m = proximity weight for fixture m
 *   H   = home advantage in Elo (ORACLE_V3_BT_HOME_ADV)
 *
 * Zero DB dependencies — pure math module.
 */

// ─── Types ──────────────────────────────────────────────────

export interface BTFixture {
  /** Home team ID */
  homeTeam: string;
  /** Away team ID */
  awayTeam: string;
  /** Expected score for home team from de-vigged odds consensus (0-1) */
  homeES: number;
  /** Proximity weight: w_m = 1 / (1 + d_m/7) where d_m = days to kickoff */
  weight: number;
  /** Fixture ID for audit trail */
  fixtureId: number;
}

export interface BTSolveInput {
  /** All fixtures in the rolling window for this league */
  fixtures: BTFixture[];
  /** Prior means (B values) for each team: teamId → B_value */
  priorMeans: Map<string, number>;
  /** Prior standard deviation (σ_prior): higher = weaker prior, more data-driven */
  sigmaPrior: number;
  /** Home advantage in Elo points */
  homeAdv: number;
  /** Max iterations for Newton-Raphson */
  maxIter?: number;
  /** Convergence threshold (max |step| in Elo points) */
  convergenceTol?: number;
}

export interface BTSolveResult {
  /** MAP ratings: teamId → R_v3 */
  ratings: Map<string, number>;
  /** Standard errors from Hessian inverse diagonal: teamId → σ_BT */
  stdErrors: Map<string, number>;
  /** Number of Newton-Raphson iterations */
  iterations: number;
  /** Max absolute step in final iteration */
  maxStep: number;
  /** Whether the solver converged */
  converged: boolean;
  /** Ordered team IDs (internal indexing) */
  teamOrder: string[];
}

// ─── Elo sigmoid ────────────────────────────────────────────

/**
 * Standard Elo expected score: σ(x) = 1 / (1 + 10^(-x/400))
 */
export function btExpectedScore(ratingDiff: number): number {
  return 1 / (1 + Math.pow(10, -ratingDiff / 400));
}

/** Derivative of Elo sigmoid: σ'(x) = σ(x) × (1-σ(x)) × ln(10)/400 */
function btExpectedScoreDeriv(ratingDiff: number): number {
  const s = btExpectedScore(ratingDiff);
  return s * (1 - s) * (Math.LN10 / 400);
}

// ─── Linear algebra helpers ─────────────────────────────────

/**
 * Solve Ax = b via Gaussian elimination with partial pivoting.
 * Operates in-place on A and b. Returns x.
 * For small N (≤20 teams per league), this is fast and stable.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxVal = Math.abs(A[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > maxVal) {
        maxVal = Math.abs(A[row][col]);
        maxRow = row;
      }
    }

    // Swap rows
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
      [b[col], b[maxRow]] = [b[maxRow], b[col]];
    }

    // Check for singular matrix
    if (Math.abs(A[col][col]) < 1e-12) {
      // Near-singular: set this variable to 0
      b[col] = 0;
      A[col][col] = 1;
      for (let j = col + 1; j < n; j++) A[col][j] = 0;
      continue;
    }

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / A[col][col];
      for (let j = col; j < n; j++) {
        A[row][j] -= factor * A[col][j];
      }
      b[row] -= factor * b[col];
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < n; j++) {
      sum -= A[i][j] * x[j];
    }
    x[i] = Math.abs(A[i][i]) > 1e-12 ? sum / A[i][i] : 0;
  }

  return x;
}

/**
 * Compute diagonal of inverse of matrix H (for standard errors).
 * Uses Gaussian elimination to solve H × X = I column by column,
 * but we only keep the diagonal elements.
 *
 * For n ≤ 20 this is fine (~8000 operations).
 */
function hessianInverseDiagonal(H: number[][]): number[] {
  const n = H.length;
  const diag = new Array(n).fill(0);

  // We need the full inverse diagonal, so solve H × e_i = x_i for each i
  // and collect x_i[i]. More efficient: just invert fully for small n.

  // Deep copy H for LU
  const A = H.map(row => [...row]);

  // Compute full inverse via Gauss-Jordan
  const augmented = A.map((row, i) => {
    const identity = new Array(n).fill(0);
    identity[i] = 1;
    return [...row, ...identity];
  });

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(augmented[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row][col]) > maxVal) {
        maxVal = Math.abs(augmented[row][col]);
        maxRow = row;
      }
    }

    if (maxRow !== col) {
      [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];
    }

    if (Math.abs(augmented[col][col]) < 1e-12) {
      diag[col] = 1e6; // Singular → very large std error
      continue;
    }

    const pivot = augmented[col][col];
    for (let j = 0; j < 2 * n; j++) {
      augmented[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = 0; j < 2 * n; j++) {
        augmented[row][j] -= factor * augmented[col][j];
      }
    }
  }

  // Extract diagonal of inverse (right half of augmented matrix)
  for (let i = 0; i < n; i++) {
    diag[i] = augmented[i][n + i];
  }

  return diag;
}

// ─── Main BT solver ─────────────────────────────────────────

/**
 * Solve for Bradley-Terry MAP ratings via Newton-Raphson.
 *
 * Given a set of fixtures with odds-implied expected scores and prior
 * means (B values), find ratings R that maximize the log-posterior:
 *
 *   L(R) = Σ_m w_m × [ES_m × log(Ê_m) + (1-ES_m) × log(1-Ê_m)]
 *          - Σ_i (R_i - μ_i)² / (2σ²)
 *
 * Returns MAP ratings + standard errors from the Hessian inverse.
 */
export function solveBT(input: BTSolveInput): BTSolveResult {
  const {
    fixtures,
    priorMeans,
    sigmaPrior,
    homeAdv,
    maxIter = 50,
    convergenceTol = 0.01,
  } = input;

  // ── Build team index ──────────────────────────────────────
  const teamSet = new Set<string>();
  for (const f of fixtures) {
    teamSet.add(f.homeTeam);
    teamSet.add(f.awayTeam);
  }
  const teams = [...teamSet].sort();
  const teamIndex = new Map<string, number>();
  teams.forEach((t, i) => teamIndex.set(t, i));
  const n = teams.length;

  if (n === 0) {
    return {
      ratings: new Map(),
      stdErrors: new Map(),
      iterations: 0,
      maxStep: 0,
      converged: true,
      teamOrder: [],
    };
  }

  // ── Initialize R = prior means ────────────────────────────
  const R = teams.map(t => priorMeans.get(t) ?? 1500);
  const mu = teams.map(t => priorMeans.get(t) ?? 1500);
  const sigmaSquared = sigmaPrior * sigmaPrior;

  // ── Build fixture index pairs ─────────────────────────────
  const fixtureIndices = fixtures.map(f => ({
    homeIdx: teamIndex.get(f.homeTeam)!,
    awayIdx: teamIndex.get(f.awayTeam)!,
    homeES: f.homeES,
    weight: f.weight,
  }));

  // ── Newton-Raphson iterations ─────────────────────────────
  let iterations = 0;
  let maxStep = Infinity;
  let converged = false;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;

    // Gradient and Hessian
    const grad = new Array(n).fill(0);
    const hess: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

    // Likelihood terms from fixtures
    for (const f of fixtureIndices) {
      const diff = R[f.homeIdx] - R[f.awayIdx] + homeAdv;
      const eHat = btExpectedScore(diff);
      const eHatDeriv = btExpectedScoreDeriv(diff);

      // Gradient: ∂L/∂R_home += w × (ES - Ê) × Ê'/ (Ê(1-Ê))
      // Simplifies to: w × (ES - Ê) × ln(10)/400
      // Actually: ∂L/∂R_home = w × [ES/Ê - (1-ES)/(1-Ê)] × Ê'
      // But since Ê' = Ê(1-Ê) × ln(10)/400:
      // ∂L/∂R_home = w × [ES × (1-Ê) - (1-ES) × Ê] × ln(10)/400
      //            = w × (ES - Ê) × ln(10)/400
      const gradTerm = f.weight * (f.homeES - eHat) * (Math.LN10 / 400);

      grad[f.homeIdx] += gradTerm;
      grad[f.awayIdx] -= gradTerm; // symmetric: away gradient is negative of home

      // Hessian: ∂²L/∂R²
      // = -w × Ê' × ln(10)/400 = -w × Ê(1-Ê) × (ln(10)/400)²
      const hessTerm = -f.weight * eHat * (1 - eHat) * (Math.LN10 / 400) ** 2;

      hess[f.homeIdx][f.homeIdx] += hessTerm;
      hess[f.awayIdx][f.awayIdx] += hessTerm;
      hess[f.homeIdx][f.awayIdx] -= hessTerm;
      hess[f.awayIdx][f.homeIdx] -= hessTerm;
    }

    // Prior terms: -∂/∂R_i [(R_i - μ_i)² / (2σ²)]
    for (let i = 0; i < n; i++) {
      grad[i] -= (R[i] - mu[i]) / sigmaSquared;
      hess[i][i] -= 1 / sigmaSquared;
    }

    // Solve Hessian × step = -gradient
    // (Newton step: R_new = R - H^{-1} × grad)
    const negGrad = grad.map(g => -g);

    // Deep copy hessian for solver (it modifies in place)
    const hessCopy = hess.map(row => [...row]);
    const step = solveLinearSystem(hessCopy, negGrad);

    // Apply step (Newton: R += step, but our equation is H×step = -grad, so R -= step)
    // Actually: Newton step is δ = -H^{-1} × grad, so we solve H×δ = -grad, then R += δ
    maxStep = 0;
    for (let i = 0; i < n; i++) {
      // Damping for stability: cap individual steps at ±100 Elo
      const clampedStep = Math.max(-100, Math.min(100, step[i]));
      R[i] += clampedStep;
      maxStep = Math.max(maxStep, Math.abs(clampedStep));
    }

    if (maxStep < convergenceTol) {
      converged = true;
      break;
    }
  }

  // ── Extract standard errors from Hessian inverse diagonal ──
  // Rebuild final Hessian at converged point
  const finalHess: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const f of fixtureIndices) {
    const diff = R[f.homeIdx] - R[f.awayIdx] + homeAdv;
    const eHat = btExpectedScore(diff);
    const hessTerm = -f.weight * eHat * (1 - eHat) * (Math.LN10 / 400) ** 2;

    finalHess[f.homeIdx][f.homeIdx] += hessTerm;
    finalHess[f.awayIdx][f.awayIdx] += hessTerm;
    finalHess[f.homeIdx][f.awayIdx] -= hessTerm;
    finalHess[f.awayIdx][f.homeIdx] -= hessTerm;
  }

  for (let i = 0; i < n; i++) {
    finalHess[i][i] -= 1 / sigmaSquared;
  }

  // Negate Hessian (we want variance = diag((-H)^{-1}))
  const negHess = finalHess.map(row => row.map(v => -v));
  const invDiag = hessianInverseDiagonal(negHess);

  // Build result maps
  const ratings = new Map<string, number>();
  const stdErrors = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    ratings.set(teams[i], R[i]);
    // std error = sqrt(variance), variance = diag element of (-H)^{-1}
    const variance = Math.max(0, invDiag[i]);
    stdErrors.set(teams[i], Math.sqrt(variance));
  }

  return {
    ratings,
    stdErrors,
    iterations,
    maxStep,
    converged,
    teamOrder: teams,
  };
}
