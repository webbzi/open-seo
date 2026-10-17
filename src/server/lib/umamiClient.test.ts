import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebsite, listWebsites } from "./umamiClient";

const config = {
  baseUrl: "https://umami.example.com",
  apiKey: "umami_test-key",
};

const fetchMock = vi.fn<typeof fetch>();

const website = (id: number) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  name: `Site ${id}`,
  domain: `site${id}.com`,
});

const page = (
  data: ReturnType<typeof website>[],
  count: number,
  pageSize = 2,
) => Response.json({ data, count, page: 1, pageSize });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

describe("listWebsites", () => {
  it("reads every page with the bearer key", async () => {
    fetchMock
      .mockResolvedValueOnce(page([website(1), website(2)], 3))
      .mockResolvedValueOnce(page([website(3)], 3));

    const websites = await listWebsites(config);

    expect(websites.map((w) => w.name)).toEqual(["Site 1", "Site 2", "Site 3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toHaveProperty(
      "href",
      "https://umami.example.com/api/websites?includeTeams=true&page=2&pageSize=100",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer umami_test-key",
    );
  });

  it.each([
    [
      "401",
      () => new Response("bad key umami_test-key", { status: 401 }),
      { code: "umami_unauthorized", retryable: false },
    ],
    [
      "404",
      () => new Response(null, { status: 404 }),
      { code: "umami_website_not_found", retryable: false },
    ],
    [
      "429 with Retry-After",
      () =>
        new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
      { code: "umami_rate_limited", retryable: true, retryAfterSeconds: 30 },
    ],
    [
      "500",
      () => new Response("stack trace from umami.example.com", { status: 500 }),
      { code: "umami_upstream_unavailable", retryable: true },
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed: https://umami.example.com");
      },
      { code: "umami_upstream_unavailable", retryable: true },
    ],
    [
      "a 2xx failing the schema",
      () => Response.json({ data: [{ id: "not-a-uuid" }], count: 1 }),
      { code: "umami_malformed_response", retryable: false },
    ],
  ])("maps %s to a safe UmamiError", async (_, respond, expected) => {
    fetchMock.mockImplementation(async () => respond());

    const error: unknown = await listWebsites(config).catch((e: unknown) => e);

    expect(error).toMatchObject({ name: "UmamiError", ...expected });
    expect(String(error)).not.toMatch(/umami\.example\.com|umami_test-key/);
  });
});

describe("getWebsite", () => {
  it("does not read an HTML 200 as a deleted website", async () => {
    fetchMock.mockResolvedValue(new Response("<html>login</html>"));

    await expect(getWebsite(config, website(1).id)).rejects.toMatchObject({
      code: "umami_malformed_response",
    });
  });
});
