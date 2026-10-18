import { parseAppStoreId, type ResolvedTarget } from "@zhuixin/shared";
import { fail } from "../errors.js";
import { descriptor, type ResolveOutput, type SourceProvider } from "./types.js";

interface ITunesResult {
  trackId?: number;
  trackName?: string;
  trackCensoredName?: string;
  bundleId?: string;
  version?: string;
  sellerName?: string;
  artistName?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  price?: number;
  formattedPrice?: string;
  primaryGenreName?: string;
  genres?: string[];
  minimumOsVersion?: string;
  fileSizeBytes?: string;
}

interface ITunesLookup {
  resultCount: number;
  results: ITunesResult[];
}

export class AppStoreProvider implements SourceProvider {
  readonly descriptor = descriptor(
    "app-store",
    "ios",
    "App Store",
    true,
    "ready",
    "ipatool + iTunes Lookup"
  );

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  canHandle(input: string): boolean {
    return parseAppStoreId(input) !== null;
  }

  async resolve(input: string): Promise<ResolveOutput> {
    const parsed = parseAppStoreId(input);
    if (!parsed) {
      fail("UNSUPPORTED_SOURCE", "这不是可识别的 App Store 链接或 App ID。");
    }

    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("id", String(parsed.appId));
    url.searchParams.set("country", parsed.country);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" }
      });
    } catch (error) {
      fail(
        "NETWORK_ERROR",
        "无法访问 iTunes Lookup，请检查网络或代理设置。",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!response.ok) {
      fail("NETWORK_ERROR", `iTunes Lookup 返回 HTTP ${response.status}。`);
    }

    const lookup = (await response.json()) as ITunesLookup;
    const item = lookup.results?.[0];
    if (!item) {
      fail(
        "APP_NOT_FOUND",
        `在 App Store ${parsed.country.toUpperCase()} 没有找到 ID ${parsed.appId}。`
      );
    }

    const target: ResolvedTarget = {
      targetRef: {
        platform: "ios",
        sourceId: "app-store",
        sourceRef: String(parsed.appId)
      },
      name: item.trackName ?? item.trackCensoredName ?? `App ${parsed.appId}`,
      publisher: item.sellerName ?? item.artistName,
      version: item.version,
      bundleId: item.bundleId,
      iconUrl: item.artworkUrl512 ?? item.artworkUrl100,
      storeUrl:
        item.trackViewUrl ??
        `https://apps.apple.com/${parsed.country}/app/id${parsed.appId}`,
      metadata: {
        country: parsed.country,
        price: item.price,
        formattedPrice: item.formattedPrice,
        primaryGenreName: item.primaryGenreName,
        genres: item.genres ?? [],
        minimumOsVersion: item.minimumOsVersion,
        fileSizeBytes: item.fileSizeBytes
      }
    };

    return { target, raw: lookup };
  }
}
