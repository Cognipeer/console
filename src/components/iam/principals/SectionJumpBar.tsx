'use client';

import { useEffect, useState } from 'react';
import { activeSection, sectionAnchor, type PersonSection } from './sectionNav';
import styles from './PrincipalDetail.module.css';

/** Distance from the top of the viewport at which a section counts as the one being read. */
const READING_OFFSET = 96;

/**
 * The jump bar of a long page: one link per section, sticky while the page scrolls,
 * with the section being read highlighted. The links are plain anchors (they work
 * without script); the highlight follows the scroll of whatever container scrolls.
 */
export default function SectionJumpBar({
  sections,
  label,
  nameOf,
}: {
  sections: readonly PersonSection[];
  label: string;
  nameOf: (section: PersonSection) => string;
}) {
  const [current, setCurrent] = useState<PersonSection | null>(sections[0] ?? null);

  const key = sections.join('|');
  useEffect(() => {
    const ids = key.split('|') as PersonSection[];
    const update = () => {
      const tops = ids
        .flatMap((id) => {
          const el = document.getElementById(sectionAnchor(id));
          return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
        })
        .sort((a, b) => a.top - b.top);
      setCurrent(activeSection(tops, READING_OFFSET));
    };
    update();
    // Capture phase: scroll events do not bubble, and the page may scroll inside a container.
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [key]);

  return (
    <nav aria-label={label} className={styles.jumpBar} data-testid="section-jump-bar">
      {sections.map((section) => (
        <a
          key={section}
          href={`#${sectionAnchor(section)}`}
          className={styles.jumpLink}
          data-active={current === section ? 'true' : undefined}
          aria-current={current === section ? 'location' : undefined}
          onClick={(event) => {
            const el = document.getElementById(sectionAnchor(section));
            if (!el) return;
            event.preventDefault();
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setCurrent(section);
          }}
        >
          {nameOf(section)}
        </a>
      ))}
    </nav>
  );
}
