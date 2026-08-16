import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { register } from '../api/endpoints';
import type { Faction } from '../api/types';
import { ErrorPanel } from '../components/StatusPanels';
import { FactionPicker } from './FactionPicker';

/** Shown once the account exists but has no faction yet (i.e. it hasn't registered). */
export function RegisterScreen(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [faction, setFaction] = useState<Faction | undefined>(undefined);

  const registerMutation = useMutation({
    mutationFn: (input: { name: string; faction: Faction }) => register(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const canSubmit = name.trim().length > 0 && faction !== undefined && !registerMutation.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit || faction === undefined) {
      return;
    }
    registerMutation.mutate({ name: name.trim(), faction });
  }

  return (
    <form className="panel screen" onSubmit={handleSubmit}>
      <h2 className="screen__title">{t('register.title')}</h2>

      <label className="field">
        <span className="field__label">{t('register.nameLabel')}</span>
        <input
          className="field__input"
          type="text"
          value={name}
          placeholder={t('register.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="field">
        <span className="field__label">{t('register.factionLabel')}</span>
        <FactionPicker value={faction} onChange={setFaction} />
      </div>

      <button type="submit" className="button button--primary" disabled={!canSubmit}>
        {registerMutation.isPending ? t('actions.submitting') : t('register.submit')}
      </button>

      {registerMutation.isError && <ErrorPanel error={registerMutation.error} />}
    </form>
  );
}
