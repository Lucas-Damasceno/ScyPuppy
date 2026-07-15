import { useEffect, useRef } from "react";
import { listen, type Event } from "@tauri-apps/api/event";

type TauriEventHandler<T> = (event: Event<T>) => void;

export function useTauriEvent<T>(eventName: string, handler: TauriEventHandler<T>, enabled = true) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<T>(eventName, (event) => handlerRef.current(event))
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, eventName]);
}
