'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Badge, Tooltip } from '@mantine/core';
import { IconPin, IconPinFilled, IconSearch, IconStar, IconX } from '@tabler/icons-react';
import {
  DASHBOARD_CATEGORY_LABELS,
  DASHBOARD_CATEGORY_ORDER,
  type DashboardServiceDefinition,
} from '@/lib/utils/dashboardServices';
import { useTranslations } from '@/lib/i18n';
import classes from './LauncherShell.module.css';

interface ServiceLauncherProps {
  open: boolean;
  onClose: () => void;
  services: DashboardServiceDefinition[];
  recents: DashboardServiceDefinition[];
  pinnedIds: Set<string>;
  onTogglePin: (id: string) => void;
  onSelect: (service: DashboardServiceDefinition) => void;
}

type CategoryKey = 'all' | (typeof DASHBOARD_CATEGORY_ORDER)[number];

export default function ServiceLauncher({
  open,
  onClose,
  services,
  recents,
  pinnedIds,
  onTogglePin,
  onSelect,
}: ServiceLauncherProps) {
  const tNav = useTranslations('navigation');
  const [q, setQ] = useState('');
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('all');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setActiveCategory('all');
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const navigable = useMemo(
    () => services.filter((s) => s.id !== 'services-home'),
    [services],
  );

  const counts = useMemo(() => {
    const result: Record<CategoryKey, number> = {
      all: navigable.length,
      operate: 0,
      build: 0,
      data: 0,
      admin: 0,
    };
    for (const svc of navigable) {
      result[svc.category] += 1;
    }
    return result;
  }, [navigable]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();
    return navigable.filter((svc) => {
      if (activeCategory !== 'all' && svc.category !== activeCategory) {
        return false;
      }
      if (!query) return true;
      const label = tNav(svc.navLabelKey).toLowerCase();
      const desc = tNav(svc.navDescriptionKey).toLowerCase();
      const kw = svc.searchKeywords.join(' ').toLowerCase();
      return (
        label.includes(query) || desc.includes(query) || kw.includes(query)
      );
    });
  }, [navigable, activeCategory, q, tNav]);

  if (!open) return null;

  const categories: { key: CategoryKey; label: string }[] = [
    { key: 'all', label: 'All' },
    ...DASHBOARD_CATEGORY_ORDER.map((cat) => ({
      key: cat as CategoryKey,
      label: DASHBOARD_CATEGORY_LABELS[cat],
    })),
  ];

  return (
    <div
      className={classes.launcherOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Service launcher"
    >
      <button
        type="button"
        className={classes.launcherBackdrop}
        onClick={onClose}
        aria-label="Close launcher"
        tabIndex={-1}
      />
      <div className={classes.launcher}>
        <div className={classes.launcherHeader}>
          <div className={classes.launcherSearch}>
            <IconSearch size={17} stroke={1.7} />
            <input
              ref={inputRef}
              placeholder={`Search across ${navigable.length} services…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span className={classes.kbdKey}>ESC</span>
          </div>
          <ActionIcon
            variant="subtle"
            color="gray"
            radius="md"
            size="lg"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX size={16} />
          </ActionIcon>
        </div>

        <div className={classes.launcherBody}>
          <div className={classes.launcherSidebar}>
            {categories.map((cat) => (
              <button
                key={cat.key}
                type="button"
                className={`${classes.launcherCat} ${activeCategory === cat.key ? classes.launcherCatActive : ''}`}
                onClick={() => setActiveCategory(cat.key)}
              >
                <span>{cat.label}</span>
                <span className={classes.launcherCatCount}>{counts[cat.key]}</span>
              </button>
            ))}
            <div className={classes.launcherSidebarDivider} />
            <div className={`${classes.launcherCat} ${classes.launcherCatStatic}`}>
              <IconPin size={13} stroke={1.7} />
              <span>Pinned</span>
              <span className={classes.launcherCatCount}>{pinnedIds.size}</span>
            </div>
            <div className={`${classes.launcherCat} ${classes.launcherCatStatic}`}>
              <IconStar size={13} stroke={1.7} />
              <span>Popular</span>
              <span className={classes.launcherCatCount}>
                {navigable.filter((s) => s.popular).length}
              </span>
            </div>
          </div>

          <div className={classes.launcherMain}>
            {q.trim() === '' && recents.length > 0 && activeCategory === 'all' ? (
              <>
                <div className={classes.launcherSectionTitle}>Recently visited</div>
                <div className={classes.launcherRecent}>
                  {recents.map((svc) => {
                    const Icon = svc.icon;
                    return (
                      <button
                        type="button"
                        key={svc.id}
                        className={classes.chip}
                        onClick={() => {
                          onSelect(svc);
                          onClose();
                        }}
                      >
                        <span className={classes.chipIcon}>
                          <Icon size={11} stroke={1.7} />
                        </span>
                        {tNav(svc.navLabelKey)}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}

            <div className={classes.launcherSectionTitle}>
              {q.trim()
                ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''} for "${q.trim()}"`
                : `${activeCategory === 'all' ? 'All' : DASHBOARD_CATEGORY_LABELS[activeCategory as Exclude<CategoryKey, 'all'>]} services · ${filtered.length}`}
            </div>

            {filtered.length === 0 ? (
              <div className={classes.launcherEmpty}>
                <IconSearch size={24} stroke={1.6} />
                <div>No services match &ldquo;{q}&rdquo;</div>
              </div>
            ) : (
              <div className={classes.svcGrid}>
                {filtered.map((svc) => {
                  const Icon = svc.icon;
                  const isPinned = pinnedIds.has(svc.id);
                  return (
                    <button
                      type="button"
                      key={svc.id}
                      className={classes.svcCard}
                      onClick={() => {
                        onSelect(svc);
                        onClose();
                      }}
                    >
                      <span className={classes.svcCardIcon}>
                        <Icon size={17} stroke={1.7} />
                      </span>
                      <span className={classes.svcCardBody}>
                        <span className={classes.svcCardName}>
                          {tNav(svc.navLabelKey)}
                          {svc.badge === 'new' ? (
                            <Badge size="xs" color="teal" variant="filled" radius="sm">
                              NEW
                            </Badge>
                          ) : null}
                          {svc.popular ? (
                            <IconStar size={11} stroke={1.7} className={classes.svcStar} />
                          ) : null}
                        </span>
                        <span className={classes.svcCardDesc}>
                          {tNav(svc.navDescriptionKey)}
                        </span>
                      </span>
                      <Tooltip label={isPinned ? 'Unpin' : 'Pin to rail'} withArrow>
                        <button
                          type="button"
                          className={`${classes.svcPin} ${isPinned ? classes.svcPinActive : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin(svc.id);
                          }}
                          aria-label={isPinned ? 'Unpin' : 'Pin to rail'}
                        >
                          {isPinned ? (
                            <IconPinFilled size={13} stroke={1.7} />
                          ) : (
                            <IconPin size={13} stroke={1.7} />
                          )}
                        </button>
                      </Tooltip>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className={classes.launcherFooter}>
          <span>
            <span className={classes.kbdKey}>↑↓</span> navigate
          </span>
          <span>
            <span className={classes.kbdKey}>⏎</span> open
          </span>
          <span className={classes.launcherFooterRight}>
            Drag services to the rail to pin
          </span>
        </div>
      </div>
    </div>
  );
}
