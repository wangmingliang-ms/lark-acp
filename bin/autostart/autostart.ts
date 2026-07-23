/**
 * OS-native boot autostart for the Humming gateway. Linux → persistent
 * user-systemd unit; Windows → a boot-triggered Task Scheduler task.
 * Detection and side effects are injected so the logic is unit-testable.
 */

/** Which installer applies, or a human-readable reason none does. */
export type AutostartTarget = "systemd" | "windows-task" | { readonly unsupported: string };

/** Mechanism label carried in reports. */
export type AutostartMechanism = "systemd" | "windows-task";

/** Result of an `ensureAutostart` or `disableAutostart` call. */
export type AutostartReport =
  | { readonly kind: "installed"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "already-current";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "disabled"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "already-disabled";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "enabled"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "not-installed";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "uninstalled"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "already-uninstalled";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "skipped"; readonly reason: string };

/** Result of a `queryAutostart` call: what's installed and whether it's active. */
export type AutostartStatus =
  | { readonly kind: "enabled"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "installed-disabled";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | {
      readonly kind: "not-installed";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/** Inputs to platform detection (injected for tests). */
export interface AutostartEnv {
  readonly platform: NodeJS.Platform;
  readonly systemdAvailable: boolean;
}

/**
 * Decide which autostart mechanism fits the current OS. WSL is treated as
 * ordinary Linux.
 */
export function detectAutostartTarget(env: AutostartEnv): AutostartTarget {
  if (env.platform === "win32") return "windows-task";
  if (env.platform === "linux") {
    if (env.systemdAvailable) return "systemd";
    return { unsupported: "linux without user systemd (systemctl --user unavailable)" };
  }
  return { unsupported: `unsupported platform: ${env.platform}` };
}

/**
 * Injected seams for `ensureAutostart`: platform inputs plus the two
 * platform installers (already bound to their real fs/runner deps by the
 * caller). Lets the dispatcher be tested without real side effects.
 */
export interface AutostartRuntime {
  readonly env: AutostartEnv;
  readonly installSystemd: () => AutostartReport;
  readonly installWindows: () => AutostartReport;
  readonly disableSystemd: () => AutostartReport;
  readonly disableWindows: () => AutostartReport;
  readonly enableSystemd: () => AutostartReport;
  readonly enableWindows: () => AutostartReport;
  readonly uninstallSystemd: () => AutostartReport;
  readonly uninstallWindows: () => AutostartReport;
  readonly querySystemd: () => AutostartStatus;
  readonly queryWindows: () => AutostartStatus;
}

/** Detect the platform and run the matching installer, else skip. */
export function ensureAutostart(runtime: AutostartRuntime): AutostartReport {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.installSystemd();
  if (target === "windows-task") return runtime.installWindows();
  return { kind: "skipped", reason: target.unsupported };
}

/** Detect the platform and disable the matching autostart, else skip. */
export function disableAutostart(runtime: AutostartRuntime): AutostartReport {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.disableSystemd();
  if (target === "windows-task") return runtime.disableWindows();
  return { kind: "skipped", reason: target.unsupported };
}

/** Detect the platform and enable an already-installed autostart, else skip. */
export function enableAutostart(runtime: AutostartRuntime): AutostartReport {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.enableSystemd();
  if (target === "windows-task") return runtime.enableWindows();
  return { kind: "skipped", reason: target.unsupported };
}

/** Detect the platform and remove the matching autostart files, else skip. */
export function uninstallAutostart(runtime: AutostartRuntime): AutostartReport {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.uninstallSystemd();
  if (target === "windows-task") return runtime.uninstallWindows();
  return { kind: "skipped", reason: target.unsupported };
}

/** Detect the platform and report the current autostart status. */
export function queryAutostart(runtime: AutostartRuntime): AutostartStatus {
  const target = detectAutostartTarget(runtime.env);
  if (target === "systemd") return runtime.querySystemd();
  if (target === "windows-task") return runtime.queryWindows();
  return { kind: "unsupported", reason: target.unsupported };
}
