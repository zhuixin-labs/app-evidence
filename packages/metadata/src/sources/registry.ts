import type { SourceDescriptor } from "@zhuixin/shared";
import { fail } from "../errors.js";
import { descriptor, type ResolveOutput, type SourceProvider } from "./types.js";

export class SourceRegistry {
  private readonly providers: SourceProvider[];
  readonly descriptors: SourceDescriptor[];

  constructor(providers: SourceProvider[]) {
    this.providers = providers;
    this.descriptors = [
      ...providers.map((provider) => provider.descriptor),
      descriptor(
        "direct-url",
        "windows",
        "Official direct link",
        false,
        "preview",
        "HTTPS download · verify · never executed"
      ),
      descriptor(
        "microsoft-store",
        "windows",
        "Microsoft Store",
        true,
        "evaluate",
        "Official API / enterprise distribution review"
      ),
      descriptor(
        "winget",
        "windows",
        "winget",
        false,
        "evaluate",
        "Offline export review"
      )
    ];
  }

  list(): SourceDescriptor[] {
    return this.descriptors;
  }

  async resolve(input: string): Promise<{ output: ResolveOutput; descriptor: SourceDescriptor }> {
    const provider = this.providers.find((candidate) => candidate.canHandle(input));
    if (provider) {
      return {
        output: await provider.resolve(input),
        descriptor: provider.descriptor
      };
    }

    if (/\.(msix|appx|msi|exe|zip)$/i.test(input)) {
      fail(
        "SOURCE_NOT_ENABLED",
        "Installer and package files (.msix / .appx / .msi / .exe / .zip) are not supported yet. For a Windows app, pass the folder of an installed program, for example C:\\Program Files\\<App>.",
        { sourceId: "local-file" }
      );
    }
    if (/^https?:\/\//i.test(input)) {
      fail(
        "SOURCE_NOT_ENABLED",
        "This URL is not an enabled source yet; only App Store links are supported.",
        { sourceId: "direct-url" }
      );
    }

    fail("UNSUPPORTED_SOURCE", "No source provider can handle this input.", {
      providers: this.providers.map((item) => item.descriptor.id)
    });
  }
}
