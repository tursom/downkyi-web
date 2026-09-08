import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, isAbort } from "./api";

export function useQuery<T>(path: string, interval?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    async function load() {
      try {
        const next = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(next);
          setError("");
          setUpdatedAt(new Date());
        }
      } catch (cause) {
        if (!controller.signal.aborted && !isAbort(cause))
          setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // Schedule after completion so slow requests cannot overlap or overwrite newer data.
          if (interval) timer = setTimeout(() => void load(), interval);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, interval, revision]);

  return { data, error, loading, updatedAt, refresh };
}
