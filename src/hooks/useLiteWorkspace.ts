import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/tauri";
import type {
  Capture,
  CaptureErrorEvent,
  CaptureFilter,
  CaptureUpdatedEvent,
  Context,
  LibraryCounts,
} from "../types";
import { useTauriEvent } from "./useTauriEvent";

type LiteWorkspaceQuery = {
  contextId: string | null;
  search: string;
  page: number;
};

const emptyCounts: LibraryCounts = { all: 0, inbox: 0, content_base: 0 };
const capturePageSize = 50;

function toCaptureFilter(query: LiteWorkspaceQuery): CaptureFilter {
  return {
    context_id: query.contextId,
    search: query.search.trim() || null,
    tag: null,
    limit: capturePageSize,
    offset: Math.max(0, query.page) * capturePageSize,
  };
}

export function useLiteWorkspace(query: LiteWorkspaceQuery, onError: (message: string) => void) {
  const [contexts, setContexts] = useState<Context[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureTotal, setCaptureTotal] = useState(0);
  const [counts, setCounts] = useState<LibraryCounts>(emptyCounts);
  const [isLoading, setIsLoading] = useState(true);
  const queryRef = useRef(query);
  const errorHandlerRef = useRef(onError);
  const captureRequestId = useRef(0);
  const mountedRef = useRef(true);
  queryRef.current = query;
  errorHandlerRef.current = onError;

  const refreshMetadata = useCallback(async () => {
    try {
      const [nextContexts, nextCounts] = await Promise.all([api.listContexts(), api.getLibraryCounts()]);
      if (!mountedRef.current) return;
      setContexts(nextContexts);
      setCounts(nextCounts);
    } catch (error) {
      if (mountedRef.current) errorHandlerRef.current(String(error));
    }
  }, []);

  const refreshCaptures = useCallback(async (queryOverride?: LiteWorkspaceQuery) => {
    if (!mountedRef.current) return;
    const currentRequest = ++captureRequestId.current;
    setIsLoading(true);
    try {
      const page = await api.listCapturePage(toCaptureFilter(queryOverride ?? queryRef.current));
      if (mountedRef.current && currentRequest === captureRequestId.current) {
        setCaptures(page.items);
        setCaptureTotal(page.total);
      }
    } catch (error) {
      if (mountedRef.current && currentRequest === captureRequestId.current) errorHandlerRef.current(String(error));
    } finally {
      if (mountedRef.current && currentRequest === captureRequestId.current) setIsLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async (queryOverride?: LiteWorkspaceQuery) => {
    await Promise.all([refreshMetadata(), refreshCaptures(queryOverride)]);
  }, [refreshCaptures, refreshMetadata]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captureRequestId.current += 1;
    };
  }, []);

  useEffect(() => {
    void refreshMetadata();
  }, [refreshMetadata]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshCaptures(), 140);
    return () => window.clearTimeout(timeout);
  }, [query.contextId, query.page, query.search, refreshCaptures]);

  useTauriEvent("capture-created", () => void refreshAll());
  useTauriEvent<CaptureUpdatedEvent>("capture-analysis-updated", ({ payload }) => {
    // OCR can change whether a capture matches a text search, so active searches
    // still need a silent authoritative refresh. In the regular workspace, patch
    // only the affected capture and keep the rest of the list visually stable.
    if (queryRef.current.search.trim()) {
      void refreshCaptures();
      return;
    }
    setCaptures((current) => {
      const index = current.findIndex((capture) => capture.id === payload.capture.id);
      if (index < 0) return current;
      const next = [...current];
      next[index] = payload.capture;
      return next;
    });
  });
  useTauriEvent("capture-contexts-updated", () => void refreshAll());
  useTauriEvent<CaptureErrorEvent>("capture-error", ({ payload }) => errorHandlerRef.current(payload.message));
  useTauriEvent("data-reset", () => void refreshAll());

  return { captures, captureTotal, contexts, counts, isLoading, refreshAll, refreshCaptures };
}
