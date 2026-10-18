import fs from "node:fs";
import type {
  ArtifactRecord,
  CapabilityDescriptor,
  HostPlatform,
  PackageFormat,
  TargetRecord,
  TargetPlatform
} from "@zhuixin/shared";
import type { CoreConfig } from "../config.js";

interface Definition {
  id: string;
  label: string;
  description: string;
  targetPlatforms: TargetPlatform[];
  packageFormats?: PackageFormat[];
  hostPlatforms?: HostPlatform[];
  builtIn?: boolean;
  requiresRea?: boolean;
  requiresArtifact?: boolean;
  available?: boolean;
  reason?: string;
  requiresInput?: "function" | "query";
}

const ALL_HOSTS: HostPlatform[] = ["darwin", "win32", "linux"];
const ALL_TARGETS: TargetPlatform[] = ["ios", "windows", "macos", "android", "linux"];
const LEGACY_IDS: Record<string, string> = {
  "rea:js": "javascript:analyze",
  "rea:inspect": "native:inspect",
  "rea:decompile": "native:decompile"
};

export interface CapabilityContext {
  target?: TargetRecord;
  artifact?: ArtifactRecord;
}

const DEFINITIONS: Definition[] = [
  {
    id: "inspect:ipa",
    label: "Inspect IPA",
    description: "ZIP CRC、Info.plist、Mach-O 架构与 cryptid。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    builtIn: true
  },
  {
    id: "extract:app",
    label: "Extract app",
    description: "安全解包 .app、资源与嵌套 Framework。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    builtIn: true
  },
  {
    id: "javascript:analyze",
    label: "Analyze JS",
    description: "对解包应用中的 uni-app / WebView 业务脚本做静态分析。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true
  },
  {
    id: "native:inspect",
    label: "Inspect native",
    description: "函数清单、字符串、交叉引用与证据索引。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true
  },
  {
    id: "native:search",
    label: "Search native",
    description: "按函数名或字符串搜索原生程序，为反编译提供准确符号。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true,
    requiresInput: "query"
  },
  {
    id: "native:decompile",
    label: "Decompile",
    description: "指定函数名或地址，返回 Ghidra 伪代码。",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true,
    requiresInput: "function"
  },
  {
    id: "generate:report",
    label: "Generate report",
    description: "把 Target、artifact 检查结果和分析证据整理成 Markdown。",
    targetPlatforms: ALL_TARGETS,
    builtIn: true
  },
  {
    id: "inspect:pe",
    label: "Inspect PE",
    description: "PE 头、架构、节区、导入表与 .NET 线索。",
    targetPlatforms: ["windows"],
    packageFormats: ["exe"],
    requiresArtifact: true,
    available: false,
    reason: "Windows Target Provider 待 v1.1"
  },
  {
    id: "inspect:msix",
    label: "Inspect MSIX",
    description: "AppxManifest、Identity、架构与签名状态。",
    targetPlatforms: ["windows"],
    packageFormats: ["msix", "appx"],
    requiresArtifact: true,
    available: false,
    reason: "Windows Target Provider 待 v1.1"
  },
  {
    id: "inspect:msi",
    label: "Inspect MSI",
    description: "ProductCode、UpgradeCode、文件/注册表表。",
    targetPlatforms: ["windows"],
    packageFormats: ["msi"],
    requiresArtifact: true,
    available: false,
    reason: "Windows Target Provider 待 v1.1"
  },
  {
    id: "signature:check",
    label: "Signature check",
    description: "Authenticode / MSIX 签名与证书链。",
    targetPlatforms: ["windows"],
    packageFormats: ["exe", "msi", "msix", "appx"],
    requiresArtifact: true,
    available: false,
    reason: "Windows Target Provider 待 v1.1"
  }
];

export class CapabilityRegistry {
  constructor(private readonly config: CoreConfig) {}

  private reaAvailable(): boolean {
    try {
      return fs.statSync(this.config.enginePath).isFile();
    } catch {
      return false;
    }
  }

  private evaluateDefinition(
    definition: Definition,
    context: CapabilityContext
  ): CapabilityDescriptor {
    const rea = this.reaAvailable();
    const hostPlatforms = definition.hostPlatforms ?? ALL_HOSTS;
    const hostSupported = hostPlatforms.includes(
      this.config.hostPlatform as HostPlatform
    );
    const globallyAvailable =
      hostSupported &&
      (definition.builtIn
        ? true
        : definition.requiresRea
          ? rea
          : definition.available ?? false);

    let available = globallyAvailable;
    let reason: string | undefined;
    if (!hostSupported) {
      reason = `此能力不支持 ${this.config.hostPlatform} Host；需要 ${hostPlatforms.join(" / ")}。`;
    } else if (!globallyAvailable) {
      reason = definition.requiresRea
        ? `分析引擎不可用；检查 APPTRACE_ENGINE_PATH（当前 ${this.config.enginePath}）。`
        : definition.reason;
    }

    const { target, artifact } = context;
    if (available && target && !definition.targetPlatforms.includes(target.targetRef.platform)) {
      available = false;
      reason = `此能力用于 ${definition.targetPlatforms.join(" / ")} Target，当前 Target 是 ${target.targetRef.platform}。`;
    }
    if (available && target && definition.requiresArtifact && !artifact) {
      available = false;
      reason = "请先获取并登记 artifact。";
    }
    if (
      available &&
      artifact &&
      definition.packageFormats &&
      !definition.packageFormats.includes(artifact.packageFormat)
    ) {
      available = false;
      reason = `当前 artifact 是 ${artifact.packageFormat.toUpperCase()}；此能力只支持 ${definition.packageFormats
        .map((format) => format.toUpperCase())
        .join(" / ")}。`;
    }

    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      targetPlatforms: definition.targetPlatforms,
      packageFormats: definition.packageFormats,
      hostPlatforms,
      available,
      reason,
      requiresArtifact: definition.requiresArtifact,
      requiresInput: definition.requiresInput
    };
  }

  list(context: CapabilityContext = {}): CapabilityDescriptor[] {
    return DEFINITIONS.map((definition) =>
      this.evaluateDefinition(definition, context)
    );
  }

  get(id: string, context: CapabilityContext = {}): CapabilityDescriptor | undefined {
    const canonicalId = LEGACY_IDS[id] ?? id;
    const definition = DEFINITIONS.find((item) => item.id === canonicalId);
    return definition ? this.evaluateDefinition(definition, context) : undefined;
  }
}
