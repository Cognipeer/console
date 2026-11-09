'use client';

/**
 * The section index of an agent's Build tab: every section of the page, grouped (what the agent is, what it can do,
 * how it behaves), each a jump to its section. A dot marks a section that differs from the published version, a ring
 * one the agent does not use. It follows the page: the section being read is highlighted.
 */

import { useEffect, useRef, useState } from 'react';
import { UnstyledButton } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import classes from './BuildSectionIndex.module.css';

export interface BuildIndexItem {
  /** The section's anchor is `config-<id>`. */
  id: string;
  title: string;
  state?: 'changed' | 'unset' | null;
  /** Parts of a long section, each with its own anchor (`config-<id>`). */
  parts?: Array<{ id: string; title: string }>;
}

export interface BuildIndexGroup {
  id: string;
  title: string;
  items: BuildIndexItem[];
}

export default function BuildSectionIndex({
  groups,
  onJump,
}: {
  groups: BuildIndexGroup[];
  /** Scroll to an anchor id (without the `config-` prefix). */
  onJump: (id: string) => void;
}) {
  const t = useTranslations('agents.build');
  const [active, setActive] = useState<string | null>(null);
  // After a jump the clicked entry stays lit while the page scrolls there (and when it cannot reach the top).
  const pinnedUntil = useRef(0);
  // Every anchor in page order — sections and the parts of General — so the part being read lights up too.
  const anchorKey = groups
    .flatMap((group) => group.items.flatMap((item) => [item.id, ...(item.parts ?? []).map((part) => part.id)]))
    .join('|');

  useEffect(() => {
    const ids = anchorKey.split('|').filter(Boolean);
    if (ids.length === 0) return undefined;
    let frame = 0;
    // The one being read is the last whose top has passed a line just under the page chrome. Sections are long
    // (General is a screen or more), so "the topmost visible one" would stay on General long after it scrolled by.
    const update = () => {
      frame = 0;
      if (Date.now() < pinnedUntil.current) return;
      const line = 190;
      let current: string | null = null;
      for (const id of ids) {
        const element = document.getElementById(`config-${id}`);
        if (!element || element.offsetParent === null) continue;
        if (element.getBoundingClientRect().top <= line) current = id;
        else break;
      }
      setActive(current ?? ids[0]);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    // The page scrolls inside the app shell, not the window: listen to every scroll on the way down.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [anchorKey]);

  const jump = (id: string) => {
    pinnedUntil.current = Date.now() + 900;
    setActive(id);
    onJump(id);
  };

  return (
    <nav className={classes.index} aria-label={t('sections')} data-testid="build-section-index">
      <div className={classes.heading}>{t('sections')}</div>
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.id} role="group" aria-label={group.title}>
            <div className={classes.group}>{group.title}</div>
            {group.items.map((item) => (
              <div key={item.id}>
                <UnstyledButton
                  className={classes.item}
                  data-active={active === item.id || undefined}
                  data-section={item.id}
                  aria-current={active === item.id ? 'location' : undefined}
                  onClick={() => jump(item.id)}
                >
                  <span>{item.title}</span>
                  {item.state ? (
                    <span
                      className={classes.mark}
                      data-state={item.state}
                      title={item.state === 'changed' ? t('changed') : t('notSet')}
                      aria-label={item.state === 'changed' ? t('changed') : t('notSet')}
                    >
                      {item.state === 'changed' ? '●' : '○'}
                    </span>
                  ) : null}
                </UnstyledButton>
                {item.parts?.map((part) => (
                  <UnstyledButton
                    key={part.id}
                    className={`${classes.item} ${classes.child}`}
                    data-active={active === part.id || undefined}
                    data-section={part.id}
                    aria-current={active === part.id ? 'location' : undefined}
                    onClick={() => jump(part.id)}
                  >
                    {part.title}
                  </UnstyledButton>
                ))}
              </div>
            ))}
          </div>
        ),
      )}
      <div className={classes.legend}>{t('legend')}</div>
    </nav>
  );
}
