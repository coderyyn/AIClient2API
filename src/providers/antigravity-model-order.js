/**
 * Single source of truth for the Antigravity elastic fallback chain.
 *
 * The chain used to be duplicated in the pool manager, the config defaults and
 * the config API whitelist. An earlier listing of `gemini-3.5-flash-lite` caused
 * upstream 404s; it was added back only after a real generation and upstream
 * model-list check succeeded. Keep the list here so the three consumers stay in sync.
 *
 * Ordering follows Google's Standard text input/output prices, low to high.
 * Equal-price 2.5 Flash stays ahead of 3.5 Flash-Lite. A request only falls
 * forward once its own model is exhausted.
 *
 * Only the cheapest 3.8 effort tier (`-low`) is a fallback target, and it is last:
 * the older Flash models carry per-model capacity limits that 3.8 does not share
 * (verified live 2026-10-20: accounts with 2.5/3.x Flash returning 429 still
 * served 3.8). The `-medium`/`-high`/`-tiered` tiers stay directly requestable
 * but are never fallback targets, because they spend more thinking tokens at the
 * same price and a drained 3.8 tier would turn lower-tier traffic into mass 429s.
 * 3.8 Flash doubles to $1.50 input on 2027-01-01; drop it from the chain then.
 */
export const ANTIGRAVITY_ELASTIC_MODEL_ORDER = Object.freeze([
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3-flash',
    'gemini-3.8-flash-low'
]);

export const ANTIGRAVITY_ELASTIC_SOURCE_MODEL = ANTIGRAVITY_ELASTIC_MODEL_ORDER[0];
