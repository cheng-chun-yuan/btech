"use client";

import { useEffect, useState } from "react";

const FALLBACK = 64210;
const CACHE_KEY = "btech_btc_usd";

// Module-level cache so switching views never refetches; sessionStorage extends
// that across full page navigations within the same tab.
let cached: number | null = null;
let inflight: Promise<number> | null = null;

function readSession(): number | null {
  try {
    const v = sessionStorage.getItem(CACHE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

async function loadPrice(): Promise<number> {
  if (cached != null) return cached;
  const fromSession = readSession();
  if (fromSession != null) {
    cached = fromSession;
    return cached;
  }
  if (!inflight) {
    inflight = fetch("/api/price")
      .then((r) => r.json())
      .then((d: { usd: number }) => {
        cached = d.usd ?? FALLBACK;
        try {
          sessionStorage.setItem(CACHE_KEY, String(cached));
        } catch {
          /* ignore */
        }
        return cached;
      })
      .catch(() => FALLBACK);
  }
  return inflight;
}

/**
 * Live BTC/USD price, fetched once per tab session and shared across views.
 * Returns null while the first fetch is in flight (so the UI can show a pending
 * state instead of a wrong number); resolves to the live price, or the fallback
 * only if the request fails.
 */
export function useBtcPrice(): number | null {
  const [price, setPrice] = useState<number | null>(cached ?? readSession());
  useEffect(() => {
    let cancelled = false;
    void loadPrice().then((p) => {
      if (!cancelled) setPrice(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return price;
}
