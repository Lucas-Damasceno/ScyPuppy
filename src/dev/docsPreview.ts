import { createDefaultSettings } from "../config/defaultSettings";
import type {
  Capture, Context, ContextAssignment, DataCleanupFilter, MagicSearchDocument, MagicSearchListItem,
  LocalSearchStatus, Settings, SmartContextRule,
} from "../types";

const previewKey = "docs-preview";

const productLaunch: Context = {
  id: "product-launch",
  name: "Product launch",
  normalized_name: "product launch",
  slug: "product-launch",
  created_at: new Date(Date.now() - 12 * 86_400_000).toISOString(),
  updated_at: new Date().toISOString(),
  capture_count: 8,
};

const research: Context = {
  id: "research",
  name: "Research",
  normalized_name: "research",
  slug: "research",
  created_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  updated_at: new Date().toISOString(),
  capture_count: 6,
};

function assignment(context: Context): ContextAssignment {
  return {
    ...context,
    assignment_origin: "manual",
    confidence: null,
    assigned_at: new Date().toISOString(),
  };
}

function capture(
  id: string,
  content: string,
  app: string,
  minutesAgo: number,
  contexts: Context[] = [],
  kind = "capture",
): Capture {
  return {
    id,
    content_text: content,
    captured_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    source_app_name: app,
    source_app_id: app.toLowerCase().replace(/\s+/g, "."),
    source_process_id: null,
    source_process_path: null,
    window_title: null,
    window_id: null,
    platform: "windows",
    kind,
    content_kind: "plain_text",
    metadata: {},
    assets: [],
    representations: [],
    files: [],
    clipboard_formats: [],
    tags: [],
    entities: [],
    ocr: null,
    contexts: contexts.map(assignment),
  };
}

const captures = [
  capture("launch-notes", "Quarterly launch checklist and stakeholder notes", "Slack", 2, [productLaunch]),
  capture("research-summary", "Research summary: local-first knowledge tools", "Browser", 18, [research]),
  capture("design-review", "Follow-up questions for the design review", "Documents", 1_440, [productLaunch]),
  capture("windows-build", "Reference: Windows packaging safeguards", "Windows Terminal", 1_460, [research], "reference"),
  capture("release-notes", "Release checklist and publication notes", "Browser", 4),
  capture("beta-feedback", "Customer feedback from the beta preview", "Notes", 24),
  capture("installer-results", "Windows installer verification results", "Terminal", 1_500),
  capture("next-steps", "Design review decisions and next steps", "Documents", 1_600),
];

const previewDocument: MagicSearchDocument = {
  id: "launch-brief-v1",
  root_id: "launch-brief",
  previous_document_id: null,
  version: 1,
  title: "Local-first product launch brief",
  query: "product launch and privacy decisions",
  markdown: `# Local-first product launch brief

ScryPuppy keeps captured knowledge on the user's device and makes every AI action explicit [1].

## Launch priorities

- Present the context-first workspace as the primary daily workflow [2].
- Explain that automatic clipboard monitoring is disabled by default [3].
- Ship cited Markdown documents as an editable output, not a black-box answer [1].

## Decision

The beta should lead with privacy, fast retrieval, and clear source attribution.

## Sources

1. Browser — Research summary: local-first knowledge tools
2. Slack — Quarterly launch checklist and stakeholder notes
3. Windows Terminal — Reference: Windows packaging safeguards`,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  retrieval_engine: "fts5+e5+rrf",
  retrieval_model: "intfloat/multilingual-e5-small",
  filters: {
    query: "product launch and privacy decisions",
    context_id: null,
    tag: null,
    date_from: null,
    date_to: null,
    limit: 24,
    previous_document_id: null,
    response_mode: "document",
  },
  generation_warning: null,
  evidence_count: 3,
  created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
  evidence: [captures[1], captures[0], captures[3]].map((item) => ({
    capture_id: item.id,
    captured_at: item.captured_at,
    context_names: item.contexts.map((context) => context.name),
    app_name: item.source_app_name,
    application_id: item.source_app_id,
    window_title: item.window_title,
    excerpt: item.content_text,
    matched_fields: ["content"],
    asset_paths: [],
  })),
  response_mode: "document",
  sensitive_value: null,
  answer_value: null,
};

const previewDocumentHistory: MagicSearchListItem[] = [{
  id: previewDocument.id,
  root_id: previewDocument.root_id,
  version: previewDocument.version,
  title: previewDocument.title,
  query: previewDocument.query,
  provider: previewDocument.provider,
  model: previewDocument.model,
  retrieval_engine: previewDocument.retrieval_engine,
  retrieval_model: previewDocument.retrieval_model,
  evidence_count: previewDocument.evidence_count,
  created_at: previewDocument.created_at,
  response_mode: "document",
}];

let smartRules: SmartContextRule[] = [{
  id: "design-work",
  context_id: productLaunch.id,
  name: "Design work",
  enabled: true,
  match_mode: "all",
  conditions: [
    { id: "design-app", field: "application", operator: "contains", value: "Documents" },
    { id: "design-text", field: "text", operator: "contains", value: "design" },
  ],
  created_at: new Date(Date.now() - 86_400_000).toISOString(),
  updated_at: new Date().toISOString(),
}];

let settings: Settings = createDefaultSettings({
  language: "en",
  onboarding_completed: true,
  retention_policy: "3_months",
  data_dir: "C:\\Users\\You\\AppData\\Roaming\\com.scryppy.desktop",
});

const localSearchStatus: LocalSearchStatus = {
  phase: "ready",
  model_id: "intfloat/multilingual-e5-small",
  model_name: "Multilingual E5 Small",
  cache_bytes: 487_587_840,
  indexed_count: 24,
  total_count: 24,
  pending_count: 0,
  error: null,
  can_download: false,
  can_retry: false,
  can_remove: true,
};

function filterCaptures(args: unknown): Capture[] {
  const filter = (args as { filter?: { context_id?: string | null; search?: string | null } } | undefined)?.filter;
  const query = filter?.search?.trim().toLowerCase() ?? "";
  return captures.filter((item) => {
    const matchesContext = !filter?.context_id || item.contexts.some((context) => context.id === filter.context_id);
    const matchesQuery = !query || `${item.content_text} ${item.source_app_name ?? ""}`.toLowerCase().includes(query);
    return matchesContext && matchesQuery;
  });
}

function capturePage(args: unknown): { items: Capture[]; total: number } {
  const filter = (args as {
    filter?: {
      context_id?: string | null;
      search?: string | null;
      limit?: number;
      offset?: number;
    };
  } | undefined)?.filter;
  const matches = filterCaptures(args);
  const offset = Math.max(0, filter?.offset ?? 0);
  const limit = Math.max(1, filter?.limit ?? matches.length);
  return {
    items: matches.slice(offset, offset + limit),
    total: matches.length,
  };
}

export function installDocsPreview(): void {
  if (!import.meta.env.DEV || !new URLSearchParams(window.location.search).has(previewKey)) return;

  let callbackId = 0;
  const callbacks = new Map<number, unknown>();
  const label = new URLSearchParams(window.location.search).get("window-label") ?? "main";

  const internals = {
    metadata: { currentWindow: { label } },
    transformCallback(callback: unknown) {
      callbackId += 1;
      callbacks.set(callbackId, callback);
      return callbackId;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc(path: string) {
      return path;
    },
    async invoke(command: string, args?: unknown): Promise<unknown> {
      if (command === "plugin:window|theme") {
        return new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
      }
      if (command === "plugin:event|listen") return callbackId;
      if (command === "plugin:event|unlisten" || command === "plugin:event|emit" || command === "plugin:event|emit_to") return undefined;
      if (command === "list_contexts") return [productLaunch, research];
      if (command === "list_recent_contexts") return [research, productLaunch];
      if (command === "list_context_rules") return smartRules;
      if (command === "preview_context_rule") return { match_count: 3, samples: [captures[2], captures[7]] };
      if (command === "save_context_rule") {
        const rule = (args as { rule?: SmartContextRule } | undefined)?.rule;
        if (!rule) return undefined;
        const saved = { ...rule, id: rule.id ?? `rule-${Date.now()}`, updated_at: new Date().toISOString() };
        smartRules = [...smartRules.filter((candidate) => candidate.id !== saved.id), saved];
        return { rule: saved, associations_added: 3 };
      }
      if (command === "delete_context_rule") {
        const ruleId = (args as { ruleId?: string } | undefined)?.ruleId;
        smartRules = smartRules.filter((rule) => rule.id !== ruleId);
        return undefined;
      }
      if (command === "preview_data_cleanup") {
        const filter = (args as { filter?: DataCleanupFilter } | undefined)?.filter;
        const imageOnly = filter?.content_types.length === 1 && filter.content_types[0] === "image";
        return {
          selection_token: "docs-preview-selection",
          capture_count: imageOnly ? 4 : 7,
          image_count: imageOnly ? 4 : 3,
          file_count: imageOnly ? 0 : 2,
          reclaimable_bytes: imageOnly ? 8_493_056 : 14_417_920,
          oldest_captured_at: captures[captures.length - 1]?.captured_at ?? null,
          newest_captured_at: captures[0].captured_at,
        };
      }
      if (command === "delete_data_by_filter") return { deleted_count: 7, reclaimed_bytes: 14_417_920 };
      if (command === "preview_retention_change") return {
        selection_token: "docs-preview-retention",
        capture_count: 7,
        image_count: 3,
        file_count: 2,
        reclaimable_bytes: 14_417_920,
        oldest_captured_at: captures[captures.length - 1]?.captured_at ?? null,
        newest_captured_at: captures[0].captured_at,
      };
      if (command === "apply_retention_change") {
        const policy = (args as { policy?: Settings["retention_policy"] } | undefined)?.policy ?? settings.retention_policy;
        const existingAction = (args as { existingAction?: string } | undefined)?.existingAction;
        settings = { ...settings, retention_policy: policy };
        return { settings, deleted_count: existingAction === "delete" ? 7 : 0, reclaimed_bytes: existingAction === "delete" ? 14_417_920 : 0 };
      }
      if (command === "get_library_counts") return { all: 24, inbox: 10, knowledge_base: 3 };
      if (command === "list_categories") return [];
      if (command === "list_captures") return filterCaptures(args);
      if (command === "list_capture_page") return capturePage(args);
      if (command === "get_capture") {
        const id = (args as { id?: string } | undefined)?.id;
        return captures.find((item) => item.id === id) ?? null;
      }
      if (command === "get_settings") return settings;
      if (command === "get_local_search_status") return localSearchStatus;
      if (command === "update_settings") {
        settings = { ...settings, ...((args as { settings?: Partial<Settings> } | undefined)?.settings ?? {}) };
        return settings;
      }
      if (command === "clear_ai_api_key") {
        settings = { ...settings, ai_api_key: "", ai_api_key_configured: false };
        return settings;
      }
      if (command === "get_ai_provider_options") return [
        { id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] },
        { id: "openai", name: "OpenAI", models: [{ id: "gpt-5-mini", name: "GPT-5 mini" }] },
      ];
      if (command === "preview_magic_search") return { evidence_count: 12, available_count: 24 };
      if (command === "list_magic_searches") return previewDocumentHistory;
      if (command === "get_magic_search") return previewDocument;
      if (command === "add_captures_to_context") {
        return (args as { captureIds?: string[] } | undefined)?.captureIds?.length ?? 0;
      }
      return undefined;
    },
  };

  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  });
}
