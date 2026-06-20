import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm } from "../core/geo.js";

test("haversineKm is zero for identical points", () => {
  const p = { lat: 49.7, lng: -123.15 };
  assert.equal(haversineKm(p, p), 0);
});

test("haversineKm matches a known distance within tolerance", () => {
  // Squamish (The Chief) to Vancouver, ~60 km as the crow flies.
  const chief = { lat: 49.6856, lng: -123.1486 };
  const vancouver = { lat: 49.2827, lng: -123.1207 };
  const d = haversineKm(chief, vancouver);
  assert.ok(Math.abs(d - 45) < 5, `expected ~45km, got ${d}`);
});

test("haversineKm is symmetric", () => {
  const a = { lat: 10, lng: 20 };
  const b = { lat: -30, lng: 100 };
  assert.ok(Math.abs(haversineKm(a, b) - haversineKm(b, a)) < 1e-9);
});
