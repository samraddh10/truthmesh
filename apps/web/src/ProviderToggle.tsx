import { useCallback, useState } from 'react';

import { readSettings, setProvider, type ProviderId, type SettingsResponse } from './api.ts';
import { useAsync } from './ui.tsx';

const LABELS: Record<ProviderId, string> = {
  bedrock: 'Bedrock',
  groq: 'Groq',
};

export function ProviderToggle() {
  const settings = useAsync(readSettings, 'settings');
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<SettingsResponse | null>(null);

  const current = local ?? settings.data ?? null;

  const choose = useCallback(
    async (provider: ProviderId) => {
      if (current === null || provider === current.activeProvider) return;
      setPending(provider);
      setError(null);
      try {
        setLocal(await setProvider(provider));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'could not switch provider');
      } finally {
        setPending(null);
      }
    },
    [current],
  );

  if (current === null) {
    return (
      <div className="row small provider-toggle">
        <span className="muted">Model</span>
        <span className="muted">
          {settings.error !== null ? 'unavailable' : 'loading…'}
        </span>
      </div>
    );
  }

  const activeModel =
    current.providers.find((provider) => provider.id === current.activeProvider)?.model ?? null;

  return (
    <div className="row small provider-toggle">
      <span className="muted">Model</span>

      <div className="segmented" role="group" aria-label="Inference provider">
        {current.providers.map((provider) => {
          const active = provider.id === current.activeProvider;
          return (
            <button
              key={provider.id}
              type="button"
              className="segment"
              aria-pressed={active}
              disabled={!provider.configured || pending !== null}
              title={
                provider.configured
                  ? `${LABELS[provider.id]}${provider.model === null ? '' : ` — ${provider.model}`}`
                  : `${LABELS[provider.id]} has no credentials configured on this deployment`
              }
              onClick={() => void choose(provider.id)}
            >
              {LABELS[provider.id]}
              {!provider.configured ? <span className="muted"> (not configured)</span> : null}
            </button>
          );
        })}
      </div>

      {error === null && activeModel !== null ? (
        <span className="muted provider-model" title={activeModel}>
          {activeModel}
        </span>
      ) : null}

      {error !== null ? (
        <span className="muted" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
