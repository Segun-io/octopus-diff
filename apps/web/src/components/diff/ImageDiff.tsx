import type { FileDiff } from '@octopus-diff/contracts';
import { useState } from 'react';
import { formatBytes } from '../../lib/diffKind.ts';

type Images = NonNullable<FileDiff['images']>;
type Image = NonNullable<Images['before']>;

function Picture({ image, label }: { image: Image; label: string }) {
  const source = `data:${image.mime};base64,${image.base64}`;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [size, setSize] = useState<{ source: string; text: string } | null>(null);
  const dimensions = size?.source === source ? size.text : '';
  const failed = failedSource === source;
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-3 text-xs text-muted">
        {label} · {formatBytes(image.byteLength)} {dimensions && `· ${dimensions}`}
      </figcaption>
      {failed ? (
        <p role="status">This image could not be decoded.</p>
      ) : (
        <img
          src={source}
          alt={label}
          className="mx-auto max-w-full"
          onLoad={(event) =>
            setSize({
              source,
              text: `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
            })
          }
          onError={() => setFailedSource(source)}
        />
      )}
    </figure>
  );
}

export function ImageDiff({ images }: { images: Images }) {
  const [mode, setMode] = useState('side');
  const [opacity, setOpacity] = useState(50);
  const both = images.before && images.after;
  return (
    <div className="absolute inset-0 overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
        <label>
          Image comparison{' '}
          <select className="od-btn" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="side">Side by side</option>
            <option value="overlay" disabled={!both}>
              Overlay
            </option>
            <option value="difference" disabled={!both}>
              Difference
            </option>
          </select>
        </label>
        {both && mode === 'overlay' && (
          <label className="flex items-center gap-2">
            After opacity {opacity}%
            <input
              aria-label="After opacity"
              type="range"
              min="0"
              max="100"
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
          </label>
        )}
        {both && mode === 'difference' && (
          <span>
            Black means identical pixels; the checkerboard shows areas outside either image.
          </span>
        )}
      </div>
      {images.warning && (
        <p role="status" className="mb-4 text-xs text-muted">
          {images.warning}
        </p>
      )}
      {mode === 'side' || !both ? (
        <div className="flex items-start gap-6">
          {images.before ? (
            <Picture image={images.before} label="Before" />
          ) : (
            <p className="flex-1 text-xs text-muted">No previous image</p>
          )}
          {images.after ? (
            <Picture image={images.after} label="After" />
          ) : (
            <p className="flex-1 text-xs text-muted">No current image</p>
          )}
        </div>
      ) : (
        <div
          className="grid w-max max-w-none"
          style={{
            background:
              mode === 'difference'
                ? 'conic-gradient(#bbb 25%, #777 0 50%, #bbb 0 75%, #777 0) 0 0 / 16px 16px'
                : undefined,
            isolation: 'isolate',
          }}
        >
          <div
            style={{
              gridArea: '1 / 1',
              alignSelf: 'start',
              justifySelf: 'start',
              width: 'max-content',
              height: 'max-content',
              background: mode === 'difference' ? 'white' : undefined,
            }}
          >
            <img
              alt="Before"
              src={`data:${images.before?.mime};base64,${images.before?.base64}`}
              style={{ maxWidth: 'none' }}
            />
          </div>
          <div
            style={{
              gridArea: '1 / 1',
              alignSelf: 'start',
              justifySelf: 'start',
              width: 'max-content',
              height: 'max-content',
              background: mode === 'difference' ? 'white' : undefined,
              opacity: mode === 'overlay' ? opacity / 100 : 1,
              mixBlendMode: mode === 'difference' ? 'difference' : 'normal',
            }}
          >
            <img
              alt="After"
              src={`data:${images.after?.mime};base64,${images.after?.base64}`}
              style={{ maxWidth: 'none' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
