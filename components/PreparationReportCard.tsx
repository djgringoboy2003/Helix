import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing, withAlpha } from '../constants/theme';
import type { ConversionEntry, ConversionReport } from '../services/prepare/U1ProjectPreparer';

// What retargeting a downloaded project for the U1 changed.
//
// `docs/IMPLEMENTATION_BACKLOG.md` Phase 5 asks for a warnings screen. The
// operator's real question is "what is different from what the designer
// published, and why", so the card leads with the things that changed the print
// — settings brought into range — and keeps the machine swap, which is expected
// and uninteresting, as a count.
//
// Collapsed by default: on a normal MakerWorld project this fires every time,
// and a warning that always shouts stops being read.

const DISPOSITION_LABEL: Record<ConversionEntry['disposition'], string> = {
  'machine-replaced': 'Replaced',
  'machine-removed': 'Removed',
  clamped: 'Adjusted',
  preserved: 'Kept',
};

export default function PreparationReportCard({ report }: { report: ConversionReport | null }) {
  const [open, setOpen] = useState(false);
  if (!report) return null;

  // Settings brought into range are the only entries that change the print
  // itself. Everything else is the machine swap the operator asked for.
  const adjusted = report.entries.filter((entry) => entry.disposition === 'clamped');
  const removed = report.entries.filter((entry) => entry.disposition === 'machine-removed');

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setOpen((current) => !current)}
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={
          open ? 'Hide U1 conversion details' : 'Show U1 conversion details'
        }
      >
        <MaterialCommunityIcons
          name={adjusted.length > 0 ? 'alert-circle-outline' : 'check-circle-outline'}
          size={18}
          color={adjusted.length > 0 ? colors.warning : colors.success}
        />
        <Text style={styles.title}>
          {adjusted.length > 0
            ? `Retargeted for the U1 — ${adjusted.length} setting${adjusted.length === 1 ? '' : 's'} adjusted`
            : 'Retargeted for the U1'}
        </Text>
        <MaterialCommunityIcons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={colors.subtext}
        />
      </Pressable>

      <Text style={styles.summary}>
        {report.replaced} machine setting{report.replaced === 1 ? '' : 's'} replaced with the U1&apos;s
        own, {removed.length} removed, {report.preserved} kept as the designer set them.
      </Text>

      {open ? (
        <View style={styles.details}>
          {adjusted.length === 0 && removed.length === 0 ? (
            <Text style={styles.empty}>
              Nothing the designer chose had to be changed.
            </Text>
          ) : null}

          {adjusted.map((entry) => (
            <Row key={entry.key} entry={entry} tone={colors.warning} />
          ))}
          {removed.map((entry) => (
            <Row key={entry.key} entry={entry} tone={colors.subtext} />
          ))}

          <Text style={styles.footnote}>
            The source machine&apos;s start, end and filament-change G-code was replaced with the
            Snapmaker U1&apos;s, along with its bed size, build height and motion limits.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Row({ entry, tone }: { entry: ConversionEntry; tone: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: withAlpha(tone, 0.15) }]}>
        <Text style={[styles.badgeText, { color: tone }]}>
          {DISPOSITION_LABEL[entry.disposition]}
        </Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.key}>{entry.key}</Text>
        <Text style={styles.detail}>{entry.detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  summary: {
    color: colors.subtext,
    fontSize: 13,
    lineHeight: 18,
  },
  details: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  empty: {
    color: colors.subtext,
    fontSize: 13,
    fontStyle: 'italic',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  badge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  key: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  detail: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 17,
  },
  footnote: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 17,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },
});
