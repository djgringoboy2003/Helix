import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing, withAlpha } from '../constants/theme';
import type { LoadedSlot } from '../services/filament/FilamentSlots';
import { U1_TOOLHEAD_COUNT } from '../services/filament/FilamentSlots';
import {
  describeSwapPlan,
  type MappingPlan,
  type MatchQuality,
} from '../services/filament/FilamentMappingPlanner';

// Binding each project colour to a physical toolhead.
//
// `CLAUDE.md` forbids silently guessing a filament mapping, so this screen shows
// a *proposal* and will not let it count as a decision. The Confirm button is
// the only thing that sets `confirmedAt`, and the start gate reads that — not
// the fact that a mapping happens to look right.
//
// Every colour is a row, because the operator's question is per-colour: "what
// will this part of the model print in?" Toolheads are chips on the row rather
// than a separate list, so choosing is one tap next to the colour it affects.

const QUALITY_TONE: Record<MatchQuality, 'good' | 'warn' | 'bad'> = {
  exact: 'good',
  'colour-mismatch': 'warn',
  'material-mismatch': 'warn',
  empty: 'bad',
  unknown: 'bad',
  unmapped: 'bad',
};

const TONE_COLOR = {
  good: colors.success,
  warn: colors.warning,
  bad: colors.danger,
} as const;

type Props = {
  plan: MappingPlan;
  loaded: readonly LoadedSlot[];
  confirmedAt: number | null;
  onChoose: (sourceIndex: number, toolhead: number | null) => void;
  onConfirm: () => void;
};

export default function FilamentMappingCard({
  plan,
  loaded,
  confirmedAt,
  onChoose,
  onConfirm,
}: Props) {
  const swapLines = describeSwapPlan(plan.swapPlan);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="palette-swatch-outline" size={18} color={colors.text} />
        <Text style={styles.title}>Filament mapping</Text>
        {confirmedAt ? (
          <View style={styles.confirmedPill}>
            <MaterialCommunityIcons name="check" size={12} color={colors.success} />
            <Text style={styles.confirmedText}>Confirmed</Text>
          </View>
        ) : null}
      </View>

      {plan.assessments.map((assessment) => {
        const slot = plan.mapping.slots.find(
          (item) => item.sourceIndex === assessment.sourceIndex
        );
        const tone = TONE_COLOR[QUALITY_TONE[assessment.quality]];
        return (
          <View key={assessment.sourceIndex} style={styles.row}>
            <View style={styles.rowHead}>
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: slot?.sourceColor || '#30343A' },
                ]}
              />
              <Text style={styles.rowLabel} numberOfLines={1}>
                {slot?.sourceMaterial || 'Unknown material'}
                {slot?.sourceColor ? ` ${slot.sourceColor}` : ''}
              </Text>
              {assessment.rfidLocked ? (
                <MaterialCommunityIcons name="lock-outline" size={14} color={colors.subtext} />
              ) : null}
            </View>

            <View style={styles.chips}>
              {Array.from({ length: U1_TOOLHEAD_COUNT }, (_, toolhead) => {
                const head = loaded[toolhead];
                const selected = assessment.toolhead === toolhead;
                const empty = head?.status === 'empty';
                return (
                  <Pressable
                    key={toolhead}
                    onPress={() => onChoose(assessment.sourceIndex, selected ? null : toolhead)}
                    style={[
                      styles.chip,
                      selected && { borderColor: tone, backgroundColor: withAlpha(tone, 0.16) },
                      empty && styles.chipEmpty,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Map this colour to toolhead ${toolhead}${
                      empty ? ', empty' : ''
                    }`}
                  >
                    <View
                      style={[
                        styles.chipSwatch,
                        { backgroundColor: head?.color || '#30343A' },
                      ]}
                    />
                    <Text style={[styles.chipText, selected && { color: tone }]}>
                      T{toolhead}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.rowDetail, { color: tone }]}>{assessment.message}</Text>
          </View>
        );
      })}

      {plan.warnings.length > 0 ? (
        <View style={styles.warnings}>
          {plan.warnings.map((item) => (
            <View key={`${item.code}-${item.message}`} style={styles.warningRow}>
              <MaterialCommunityIcons
                name={
                  item.level === 'blocking'
                    ? 'alert-octagon-outline'
                    : item.level === 'warning'
                      ? 'alert-outline'
                      : 'information-outline'
                }
                size={14}
                color={
                  item.level === 'blocking'
                    ? colors.danger
                    : item.level === 'warning'
                      ? colors.warning
                      : colors.subtext
                }
              />
              <Text style={styles.warningText}>{item.message}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {swapLines.length > 0 ? (
        <View style={styles.swaps}>
          <Text style={styles.swapTitle}>To print this as designed</Text>
          {swapLines.map((line) => (
            <Text key={line} style={styles.swapLine}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={onConfirm}
        disabled={!plan.ok || Boolean(confirmedAt)}
        style={[
          styles.confirm,
          (!plan.ok || Boolean(confirmedAt)) && styles.confirmDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Confirm filament mapping"
      >
        <Text style={styles.confirmLabel}>
          {confirmedAt
            ? 'Mapping confirmed'
            : plan.ok
              ? 'Confirm mapping'
              : 'Resolve the problems above'}
        </Text>
      </Pressable>
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
    gap: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  confirmedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: withAlpha(colors.success, 0.16),
  },
  confirmedText: { color: colors.success, fontSize: 11, fontWeight: '700' },
  row: { gap: spacing.xs },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  swatch: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowLabel: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  chipEmpty: { opacity: 0.45 },
  chipSwatch: { width: 12, height: 12, borderRadius: 3 },
  chipText: { color: colors.subtext, fontSize: 12, fontWeight: '700' },
  rowDetail: { fontSize: 12, lineHeight: 17 },
  warnings: { gap: spacing.xs },
  warningRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  warningText: { flex: 1, color: colors.subtext, fontSize: 12, lineHeight: 17 },
  swaps: {
    gap: 2,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.cardAlt,
  },
  swapTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  swapLine: { color: colors.subtext, fontSize: 12, lineHeight: 17 },
  confirm: {
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  confirmDisabled: { backgroundColor: colors.cardAlt },
  confirmLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
