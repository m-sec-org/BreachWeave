import { useState, useEffect, useCallback } from "react"

export function useFetch<T>(fetcher: () => Promise<T>) {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const reload = useCallback(() => {
        setLoading(true)
        setError(null)
        fetcher()
            .then(setData)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false))
    }, [fetcher])

    useEffect(reload, [reload])

    return { data, loading, error, reload }
}
