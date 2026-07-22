/**
 * OS-native boot autostart for the Humming gateway. Linux → persistent
 * user-systemd unit; Windows → a boot-triggered Task Scheduler task.
 * Detection and side effects are injected so the logic is unit-testable.
 */

/** Which installer applies, or a human-readable reason none does. */
export type AutostartTarget = "systemd" | "windows-task" | { readonly unsupported: string };

/** Mechanism label carried in reports. */
export type AutostartMechanism = "systemd" | "windows-task";

/** Result of an `ensureAutostart` call. */
export type AutostartReport =
  | { readonly kind: "installed"; readonly mechanism: AutostartMechanism; readonly path: string }
  | {
      readonly kind: "already-current";
      readonly mechanism: AutostartMechanism;
      readonly path: string;
    }
  | { readonly kind: "skipped"; readonly reason: string };

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
