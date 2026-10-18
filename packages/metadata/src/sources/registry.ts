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
        "local-file",
        "windows",
        "本地安装包",
        false,
        "preview",
        "MSIX / APPX / EXE / MSI · 只读检查"
      ),
      descriptor(
        "direct-url",
        "windows",
        "官方直链",
        false,
        "preview",
        "HTTPS 下载 · 校验 · 不执行"
      ),
      descriptor(
        "microsoft-store",
        "windows",
        "Microsoft Store",
        true,
        "evaluate",
        "官方 API / 企业分发评估"
      ),
      descriptor(
        "winget",
        "windows",
        "winget",
        false,
        "evaluate",
        "离线导出能力评估"
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
        "Windows 安装包来源将在 v1.1 接入；当前只启用 App Store。",
        { sourceId: "local-file" }
      );
    }
    if (/^https?:\/\//i.test(input)) {
      fail(
        "SOURCE_NOT_ENABLED",
        "这个 URL 还不是已启用的来源；当前只支持 App Store 链接。",
        { sourceId: "direct-url" }
      );
    }

    fail("UNSUPPORTED_SOURCE", "没有可处理这个输入的 Source Provider。", {
      providers: this.providers.map((item) => item.descriptor.id)
    });
  }
}
