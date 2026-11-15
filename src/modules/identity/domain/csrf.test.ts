import { describe, expect, it } from "vitest";

import { checkCsrf } from "./csrf";

const siteUrl = "https://shop.example.com";

describe("checkCsrf", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])("does not check safe method %s", (method) => {
    expect(checkCsrf({ method, siteUrl })).toEqual({ ok: true });
  });

  it("accepts a same-origin Sec-Fetch-Site and refuses every other value", () => {
    expect(checkCsrf({ method: "POST", siteUrl, secFetchSite: "same-origin" })).toEqual({ ok: true });
    for (const value of ["cross-site", "same-site", "none"]) {
      expect(checkCsrf({ method: "POST", siteUrl, secFetchSite: value })).toEqual({ ok: false, reason: "cross_site" });
    }
  });

  it("Sec-Fetch-Site wins over a matching Origin (a forged Origin cannot help)", () => {
    expect(checkCsrf({ method: "POST", siteUrl, secFetchSite: "cross-site", origin: siteUrl })).toEqual({
      ok: false,
      reason: "cross_site",
    });
  });

  it("falls back to Origin, then Referer", () => {
    expect(checkCsrf({ method: "POST", siteUrl, origin: "https://shop.example.com" })).toEqual({ ok: true });
    expect(checkCsrf({ method: "POST", siteUrl, origin: "https://evil.example.com" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(checkCsrf({ method: "DELETE", siteUrl, referer: "https://shop.example.com/admin/users?x=1" })).toEqual({ ok: true });
    expect(checkCsrf({ method: "PUT", siteUrl, referer: "https://shop.example.com.evil.com/" })).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("refuses a missing, 'null' or malformed Origin and a different scheme or port", () => {
    expect(checkCsrf({ method: "POST", siteUrl })).toEqual({ ok: false, reason: "no_origin" });
    expect(checkCsrf({ method: "POST", siteUrl, origin: "null" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(checkCsrf({ method: "POST", siteUrl, origin: "not a url" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(checkCsrf({ method: "POST", siteUrl, origin: "http://shop.example.com" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(checkCsrf({ method: "POST", siteUrl, origin: "https://shop.example.com:8443" })).toEqual({ ok: false, reason: "origin_mismatch" });
  });
});
