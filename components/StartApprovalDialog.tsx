import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../constants/theme';
import { cacheBustUrl } from '../services/cameraSnapshot';
import { DEFAULT_MAX_CAMERA_AGE_MS, type CameraFrameRecord } from '../services/jobs/ApprovalService';
import type { PrintJob } from '../services/jobs/PrintJobTypes';
import { criticalSettings, type SliceReview } from '../services/gcode/SliceReview';
import { shortHash } from '../services/security/FileHash';

// The last thing between a file and a moving printer.
//
// `docs/SAFETY_AND_TESTING.md` requires an explicit operator action bound to a
// fresh bed image, and `CLAUDE.md` forbids starting while that image is stale or
// unavailable. So this screen is built around the photograph: it is the largest
// thing on it, it is re-fetched on a timer, and its age is shown as a number
// rather than implied. When the frame goes stale the start control is disabled
// rather than hidden, so the reason stays visible.
//
// The confirmation is deliberately awkward. A tap is something a thumb does by
// accident on a phone in a pocket; a two-second hold is not. The hold is also
// why there is no separate "are you sure" — one considered action is better than
// two reflexive ones.

/** How long the operator holds before the print starts. */
export const HOLD_TO_START_MS = 2000;

/** How often the bed image is replaced while this screen is open. */
const CAMERA_REFRESH_MS = 5000;

const PROGRESS_TICK_MS = 50;

export interface StartApprovalResult {
  cameraFrame: CameraFrameRecord;
  bedClear: true;
}

type Props = {
  visible: boolean;
  job: PrintJob;
  /** The reviewed G-code this approval will bind to. */
  review: SliceReview;
  /** Name on the printer — what the start command will actually name. */
  filename: string;
  /** Resolved snapshot URL, or empty when no camera is configured. */
  cameraSnapshotUrl: string;
  /** Endpoint path only, recorded on the frame. Never a URL with credentials. */
  cameraEndpoint: string;
  starting: boolean;
  statusMessage?: string | null;
  errorMessage?: string | null;
  onCancel: () => void;
  onStart: (result: StartApprovalResult) => void;
};

export default function StartApprovalDialog({
  visible,
  job,
  review,
  filename,
  cameraSnapshotUrl,
  cameraEndpoint,
  starting,
  statusMessage,
  errorMessage,
  onCancel,
  onStart,
}: Props) {
  const [bedClear, setBedClear] = useState(false);
  const [nonce, setNonce] = useState(() => Date.now());
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const [frameFailed, setFrameFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [hold, setHold] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Re-opening must not inherit the previous job's confirmation: the whole
  // point of binding is that agreement does not carry across.
  useEffect(() => {
    if (!visible) return;
    setBedClear(false);
    setHold(0);
    setFrameAt(null);
    setFrameFailed(false);
    setNonce(Date.now());
  }, [visible, job.id, job.revision]);

  // A new photograph every few seconds, and a clock so its age stays honest
  // even between photographs.
  useEffect(() => {
    if (!visible || !cameraSnapshotUrl) return;
    const refresh = setInterval(() => setNonce(Date.now()), CAMERA_REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, [visible, cameraSnapshotUrl]);

  useEffect(() => () => {
    if (holdTimer.current) clearInterval(holdTimer.current);
  }, []);

  const frameAge = frameAt === null ? null : Math.max(0, now - frameAt);
  const cameraFresh =
    frameAt !== null && !frameFailed && frameAge !== null && frameAge <= DEFAULT_MAX_CAMERA_AGE_MS;

  const canStart = cameraFresh && bedClear && !starting;

  const releaseHold = useCallback(() => {
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
    setHold(0);
  }, []);

  const beginHold = useCallback(() => {
    if (!canStart) return;
    releaseHold();
    const startedAt = Date.now();
    holdTimer.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= HOLD_TO_START_MS) {
        releaseHold();
        // The frame is re-read here rather than captured on press, so the
        // record describes the image on screen at the moment of the decision.
        if (frameAt === null) return;
        onStart({
          cameraFrame: {
            capturedAt: frameAt,
            printerId: job.printerId,
            cameraEndpoint,
            jobRevision: job.revision,
          },
          bedClear: true,
        });
        return;
      }
      setHold(elapsed / HOLD_TO_START_MS);
    }, PROGRESS_TICK_MS);
  }, [canStart, cameraEndpoint, frameAt, job.printerId, job.revision, onStart, releaseHold]);

  const settings = useMemo(() => criticalSettings(review), [review]);
  const slots = job.filamentMapping?.slots ?? [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <MaterialCommunityIcons name="printer-3d-nozzle-alert" size={20} color={colors.primary} />
            <Text style={styles.title}>Ready to print</Text>
            <Pressable onPress={onCancel} hitSlop={10} accessibilityLabel="Cancel this print">
              <MaterialCommunityIcons name="close" size={22} color={colors.subtext} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <View style={styles.cameraFrame}>
              {cameraSnapshotUrl && !frameFailed ? (
                <Image
                  source={{ uri: cacheBustUrl(cameraSnapshotUrl, nonce) }}
                  style={styles.camera}
                  resizeMode="cover"
                  onLoad={() => {
                    setFrameAt(Date.now());
                    setNow(Date.now());
                  }}
                  onError={() => setFrameFailed(true)}
                />
              ) : (
                <View style={[styles.camera, styles.cameraMissing]}>
                  <MaterialCommunityIcons name="camera-off-outline" size={30} color={colors.danger} />
                  <Text style={styles.cameraMissingText}>
                    {cameraSnapshotUrl
                      ? 'The bed camera did not respond.'
                      : 'No bed camera is configured for this printer.'}
                  </Text>
                </View>
              )}
              <View style={[styles.cameraBadge, cameraFresh ? styles.badgeFresh : styles.badgeStale]}>
                <Text style={styles.cameraBadgeText}>
                  {frameAge === null
                    ? 'No image'
                    : cameraFresh
                      ? `Live · ${Math.round(frameAge / 1000)}s ago`
                      : `Stale · ${Math.round(frameAge / 1000)}s ago`}
                </Text>
              </View>
            </View>

            {!cameraFresh ? (
              <Text style={styles.blocker}>
                A print cannot start without a current view of the bed.
              </Text>
            ) : null}

            <View style={styles.fileRow}>
              <MaterialCommunityIcons name="file-document-outline" size={16} color={colors.subtext} />
              <Text style={styles.fileName} numberOfLines={1}>
                {filename}
              </Text>
              {review.sha256 ? (
                <Text style={styles.hash} accessibilityLabel="G-code fingerprint">
                  {shortHash(review.sha256)}
                </Text>
              ) : null}
            </View>

            {settings.length > 0 ? (
              <View style={styles.grid}>
                {settings.slice(0, 6).map((item) => (
                  <View key={item.label} style={styles.cell}>
                    <Text style={styles.cellLabel}>{item.label}</Text>
                    <Text style={styles.cellValue} numberOfLines={1}>
                      {item.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {slots.length > 0 ? (
              <View style={styles.mapping}>
                <Text style={styles.mappingTitle}>This will print with</Text>
                {slots.map((slot) => (
                  <View key={slot.sourceIndex} style={styles.mappingRow}>
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: slot.sourceColor || colors.cardAlt },
                      ]}
                    />
                    <Text style={styles.mappingText} numberOfLines={1}>
                      {slot.sourceMaterial || 'Filament'} {slot.sourceIndex + 1}
                    </Text>
                    <MaterialCommunityIcons name="arrow-right" size={14} color={colors.subtext} />
                    <Text style={styles.mappingTool}>
                      T{slot.toolhead ?? '?'}
                    </Text>
                    <Text style={styles.mappingLoaded} numberOfLines={1}>
                      {slot.loadedMaterial || 'unknown'}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            <Pressable
              style={styles.confirmRow}
              onPress={() => setBedClear((current) => !current)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: bedClear }}
              disabled={starting}
            >
              <MaterialCommunityIcons
                name={bedClear ? 'checkbox-marked' : 'checkbox-blank-outline'}
                size={22}
                color={bedClear ? colors.success : colors.subtext}
              />
              <Text style={styles.confirmText}>
                The bed is clear and the filament above is what I want to print.
              </Text>
            </Pressable>

            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
            {starting && statusMessage ? (
              <View style={styles.statusRow}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.statusText}>{statusMessage}</Text>
              </View>
            ) : null}
          </ScrollView>

          <Pressable
            style={[styles.holdButton, !canStart && styles.holdButtonOff]}
            onPressIn={beginHold}
            onPressOut={releaseHold}
            disabled={!canStart}
            accessibilityRole="button"
            accessibilityLabel="Hold to start the print"
            accessibilityHint="Press and hold for two seconds to start printing"
          >
            <View style={[styles.holdFill, { width: `${Math.round(hold * 100)}%` }]} />
            <MaterialCommunityIcons name="play" size={20} color={colors.text} />
            <Text style={styles.holdText}>
              {starting
                ? 'Starting…'
                : !cameraFresh
                  ? 'Waiting for a live bed image'
                  : !bedClear
                    ? 'Confirm the bed is clear'
                    : hold > 0
                      ? 'Keep holding…'
                      : 'Hold to start'}
            </Text>
          </Pressable>

          <Pressable style={styles.cancelButton} onPress={onCancel} disabled={starting}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '92%',
    gap: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '800' },
  body: { gap: spacing.md, paddingBottom: spacing.sm },

  cameraFrame: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  camera: { width: '100%', aspectRatio: 4 / 3 },
  cameraMissing: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  cameraMissingText: { color: colors.subtext, fontSize: 12, textAlign: 'center' },
  cameraBadge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  badgeFresh: { backgroundColor: 'rgba(46,203,112,0.9)' },
  badgeStale: { backgroundColor: 'rgba(255,77,79,0.9)' },
  cameraBadgeText: { color: '#04120a', fontSize: 11, fontWeight: '800' },

  blocker: { color: colors.danger, fontSize: 13, fontWeight: '700' },

  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fileName: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '700' },
  hash: { color: colors.subtext, fontSize: 11, fontWeight: '700' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: {
    minWidth: '30%',
    flexGrow: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  cellLabel: { color: colors.subtext, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  cellValue: { color: colors.text, fontSize: 13, fontWeight: '600' },

  mapping: { gap: spacing.xs },
  mappingTitle: { color: colors.subtext, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  mappingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  swatch: { width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  mappingText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '600' },
  mappingTool: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  mappingLoaded: { color: colors.subtext, fontSize: 11, maxWidth: '32%' },

  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  confirmText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 },

  error: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { color: colors.subtext, fontSize: 13 },

  holdButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  holdButtonOff: { backgroundColor: colors.cardAlt },
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  holdText: { color: colors.text, fontSize: 15, fontWeight: '800' },

  cancelButton: { alignItems: 'center', paddingVertical: spacing.sm },
  cancelText: { color: colors.subtext, fontSize: 14, fontWeight: '700' },
});
