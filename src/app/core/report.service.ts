import { Injectable, computed, inject } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { WorkspaceStore } from "../state/workspace.store";
import { type ReportInfo, documentKind, environmentText, issueUrl } from "./report";
import { UpdateService } from "./update.service";

/**
 * Report a problem: opens a prefilled GitHub issue in the browser (see `report.ts`). The app
 * sends nothing; the person reviews the form and submits it.
 */
@Injectable({ providedIn: "root" })
export class ReportService {
  private readonly updates = inject(UpdateService);
  private readonly workspace = inject(WorkspaceStore);

  /** Only when the build knows its repository (the update feed is set up). */
  readonly available = computed(() => !!this.updates.projectUrl());

  /** `error`: the text of the error banner, to fill in what happened. */
  async open(error?: string | null): Promise<void> {
    const project = this.updates.projectUrl();
    if (!project) return;
    const info = await this.info(error);
    try {
      await openUrl(issueUrl(project, info));
    } catch {
      await navigator.clipboard?.writeText(environmentText(info)).catch(() => undefined);
      this.workspace.flash(`Could not open the browser. The details are copied: report at ${project}/issues`);
    }
  }

  private async info(error?: string | null): Promise<ReportInfo> {
    let platformVersion: string | null = null;
    try {
      const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }> } }).userAgentData;
      platformVersion = (await data?.getHighEntropyValues(["platformVersion"]))?.platformVersion ?? null;
    } catch {
      /* the user agent alone is enough */
    }
    return {
      version: this.updates.version(),
      userAgent: navigator.userAgent,
      platformVersion,
      opened: documentKind(this.workspace.source()),
      error: error ?? null,
    };
  }
}
