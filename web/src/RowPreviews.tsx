// Optional thumbnail & KPI/artifact preview strip for Inbox and Tasks rows, plus lightbox dialog.

import { useEffect, useRef, useState } from "react";
import type { ArtifactBadge, PreviewImage } from "./row-previews";
import { ExternalLinkIcon } from "./ui";

export function PreviewToggleButton({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`chip preview-toggle${enabled ? " chip-active" : ""}`}
      aria-pressed={enabled}
      title="Toggle thumbnail and artifact previews"
      onClick={onToggle}
    >
      <svg className="preview-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.8" />
        <circle cx="5.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
        <path d="m14 10.5-3.2-3.2a.8.8 0 0 0-1.1 0L4.5 12.5" />
      </svg>
      <span>Previews</span>
    </button>
  );
}

function ArtifactSparkIcon() {
  return (
    <svg className="preview-artifact-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2 9.6 6.4 14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6L8 2Z" />
    </svg>
  );
}

export function RowPreviews({
  images,
  extraCount,
  artifacts,
}: {
  images: PreviewImage[];
  extraCount: number;
  artifacts: ArtifactBadge[];
}) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<PreviewImage | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (lightbox && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [lightbox]);

  if (images.length === 0 && artifacts.length === 0) return null;

  const markFailed = (url: string) => {
    setFailedUrls((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  return (
    <>
      <div className="row-previews">
        {images.map((img) => {
          const failed = failedUrls.has(img.url);
          return (
            <button
              key={img.url}
              type="button"
              className="preview-thumb-btn"
              title={img.alt}
              aria-label={`Preview ${img.alt}`}
              onClick={(e) => {
                e.stopPropagation();
                setLightbox(img);
              }}
            >
              {failed ? (
                <span className="preview-thumb-fallback">{img.alt}</span>
              ) : (
                <img
                  className="preview-thumb-img"
                  src={img.url}
                  alt={img.alt}
                  loading="lazy"
                  decoding="async"
                  width={56}
                  height={38}
                  onError={() => markFailed(img.url)}
                />
              )}
            </button>
          );
        })}
        {extraCount > 0 ? (
          <span className="preview-extra-count" title={`${extraCount} more preview images`}>
            +{extraCount}
          </span>
        ) : null}
        {artifacts.map((badge) =>
          badge.url ? (
            <a
              key={`${badge.kind}-${badge.label}-${badge.url}`}
              href={badge.url}
              target="_blank"
              rel="noreferrer"
              className={`preview-artifact-badge is-${badge.kind}`}
              title={badge.url}
              onClick={(e) => e.stopPropagation()}
            >
              <ArtifactSparkIcon />
              <span>{badge.label}</span>
              <ExternalLinkIcon />
            </a>
          ) : (
            <span key={`${badge.kind}-${badge.label}`} className={`preview-artifact-badge is-${badge.kind}`}>
              <ArtifactSparkIcon />
              <span>{badge.label}</span>
            </span>
          ),
        )}
      </div>

      {lightbox ? (
        <dialog
          ref={dialogRef}
          className="preview-lightbox"
          aria-label={lightbox.alt}
          onClose={() => setLightbox(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (e.target === e.currentTarget) dialogRef.current?.close();
          }}
        >
          <div className="preview-lightbox-head" onClick={(e) => e.stopPropagation()}>
            <span className="preview-lightbox-title">{lightbox.alt}</span>
            <button
              type="button"
              className="btn"
              autoFocus
              onClick={() => dialogRef.current?.close()}
            >
              Close
            </button>
          </div>
          <div className="preview-lightbox-body" onClick={(e) => e.stopPropagation()}>
            {failedUrls.has(lightbox.url) ? (
              <div className="pane-note">Preview image could not be loaded.</div>
            ) : (
              <img className="preview-lightbox-img" src={lightbox.url} alt={lightbox.alt} />
            )}
          </div>
        </dialog>
      ) : null}
    </>
  );
}
