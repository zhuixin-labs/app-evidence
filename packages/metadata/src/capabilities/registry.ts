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
    description: "ZIP CRC, Info.plist, Mach-O architectures and cryptid.",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    builtIn: true
  },
  {
    id: "inspect:mac-app",
    label: "Inspect macOS app",
    description:
      "Contents/Info.plist, bundle layout, architectures, signature and entitlements.",
    targetPlatforms: ["macos"],
    packageFormats: ["app"],
    requiresArtifact: true,
    builtIn: true
  },
  {
    id: "extract:app",
    label: "Extract app",
    description: "Safely unpack the .app bundle, resources and nested frameworks.",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    builtIn: true
  },
  {
    id: "javascript:analyze",
    label: "Analyze JS",
    description: "Statically analyze uni-app and WebView business scripts in the unpacked app.",
    targetPlatforms: ["ios", "macos"],
    packageFormats: ["ipa", "app"],
    requiresArtifact: true,
    requiresRea: true
  },
  {
    id: "native:inspect",
    label: "Inspect native",
    description: "Function inventory, strings, cross-references and an evidence index.",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true
  },
  {
    id: "native:search",
    label: "Search native",
    description: "Search native code by function name or string to find exact symbols for decompilation.",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true,
    requiresInput: "query"
  },
  {
    id: "native:decompile",
    label: "Decompile",
    description: "Return Ghidra pseudocode for a function name or address.",
    targetPlatforms: ["ios"],
    packageFormats: ["ipa"],
    requiresArtifact: true,
    requiresRea: true,
    requiresInput: "function"
  },
  {
    id: "generate:report",
    label: "Generate report",
    description: "Turn the target, artifact checks and analysis evidence into Markdown.",
    targetPlatforms: ALL_TARGETS,
    builtIn: true
  },
  {
    id: "inspect:pe",
    label: "Inspect PE",
    description: "PE headers, architectures, sections, imports and .NET hints.",
    targetPlatforms: ["windows"],
    packageFormats: ["exe"],
    requiresArtifact: true,
    available: false,
    reason: "Windows target provider planned for v1.1"
  },
  {
    id: "inspect:msix",
    label: "Inspect MSIX",
    description: "AppxManifest, identity, architectures and signature state.",
    targetPlatforms: ["windows"],
    packageFormats: ["msix", "appx"],
    requiresArtifact: true,
    available: false,
    reason: "Windows target provider planned for v1.1"
  },
  {
    id: "inspect:msi",
    label: "Inspect MSI",
    description: "ProductCode, UpgradeCode, file and registry tables.",
    targetPlatforms: ["windows"],
    packageFormats: ["msi"],
    requiresArtifact: true,
    available: false,
    reason: "Windows target provider planned for v1.1"
  },
  {
    id: "signature:check",
    label: "Signature check",
    description: "Authenticode and MSIX signatures with certificate chain.",
    targetPlatforms: ["windows"],
    packageFormats: ["exe", "msi", "msix", "appx"],
    requiresArtifact: true,
    available: false,
    reason: "Windows target provider planned for v1.1"
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
      reason = `This capability does not support a ${this.config.hostPlatform} host; it needs ${hostPlatforms.join(" / ")}.`;
    } else if (!globallyAvailable) {
      reason = definition.requiresRea
        ? `Analysis engine unavailable; check APPTRACE_ENGINE_PATH (currently ${this.config.enginePath}).`
        : definition.reason;
    }

    const { target, artifact } = context;
    if (available && target && !definition.targetPlatforms.includes(target.targetRef.platform)) {
      available = false;
      reason = `This capability targets ${definition.targetPlatforms.join(" / ")}; the current target is ${target.targetRef.platform}.`;
    }
    if (available && target && definition.requiresArtifact && !artifact) {
      available = false;
      reason = "Acquire and register an artifact first.";
    }
    if (
      available &&
      artifact &&
      definition.packageFormats &&
      !definition.packageFormats.includes(artifact.packageFormat)
    ) {
      available = false;
      reason = `The current artifact is ${artifact.packageFormat.toUpperCase()}; this capability supports ${definition.packageFormats
        .map((format) => format.toUpperCase())
        .join(" / ")}.`;
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
