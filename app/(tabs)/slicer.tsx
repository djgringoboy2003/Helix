import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { colors, spacing } from '../../constants/theme';
import {
  addExtractProgressListener,
  clearLastSlice,
  extractModelPlate,
  getGcodeFilamentGrams,
  getGcodeThumbnail,
  getLastSliceResult,
  getMakerWorldCookies,
  getModelPlates,
  getNativeSlicerStatus,
  getSharedMakerWorldLink,
  ModelPlate,
  NativeMakerWorldDownload,
  NativeSliceResult,
  NativeSlicerStatus,
  openMakerWorldDownloader,
  openNativeGcodePreview,
  openNativeModelPreview,
  injectTimelapseMacros,
  getU1PrinterProfile,
  pickModelFile,
  readProjectSettings,
  setFilamentSlotColors,
  collapseModelToTool,
  remapModelExtruders,
  sliceModelFile,
  setNativePrinters,
  SharedMakerWorldLink,
  uploadGcodeToPrinter,
  type SharedModelFile,
} from '../../services/nativeSlicer';
import { useMoonraker } from '../../hooks/useMoonraker';
import { useACE } from '../../hooks/useACE';
import type { AceUnit } from '../../hooks/useACE';
import { useSettings } from '../../hooks/useSettings';
import FilamentSlotsEditor, { type FilamentSlotDisplay } from '../../components/FilamentSlotsEditor';
import { normalizeFilamentSlotColors } from '../../constants/filamentColors';
import { takeMwDownload } from '../../services/mwBus';
import { subscribePendingModel, takePendingModel } from '../../services/pendingModel';
import { getImportCoordinator } from '../../services/import/ExpoImportIo';
import { detectImportSourceFromPath } from '../../services/import/ImportCoordinator';
import type { ImportAttribution, ImportSourceKind } from '../../services/import/ImportTypes';
import { runU1Preparation, summarizeReport } from '../../services/prepare/U1Preparation';
import { nativePrepareIo } from '../../services/prepare/NativePrepareIo';
import type { ConversionReport } from '../../services/prepare/U1ProjectPreparer';
import PreparationReportCard from '../../components/PreparationReportCard';
import {
  readLoadedSlots,
  readProjectFilaments,
  type ProjectFilament,
} from '../../services/filament/FilamentSlots';
import { planFilamentMapping } from '../../services/filament/FilamentMappingPlanner';
import FilamentMappingCard from '../../components/FilamentMappingCard';
import { buildVolumeOf } from '../../services/prepare/U1ProjectPreparer';
import { reviewSlicedGcode, type SliceReview } from '../../services/gcode/SliceReview';
import { expoGcodeIo } from '../../services/gcode/ExpoGcodeIo';
import SliceReviewCard from '../../components/SliceReviewCard';
import { setPrintSentNotice } from '../../services/printSentBus';
import PrintPreprocessDialog, { type PrintPref } from '../../components/PrintPreprocessDialog';
import { api, printerConnectionUrl, resolveSnapshotUrl, thumbnailUrl } from '../../services/moonraker';
import { resolveNativeMaterialProfiles } from '../../services/filamentProfiles';
import { uploadSlicedGcode } from '../../services/upload/UploadService';
import { createStartIo, createUploadIo } from '../../services/printer/MoonrakerPrinterIo';
import {
  startApprovedPrint,
  type UploadedFileFingerprint,
} from '../../services/start/StartService';
import { buildFilamentMapping, buildStartJob, newJobId } from '../../services/start/StartJob';
import { createStartApproval } from '../../services/jobs/ApprovalService';
import { grantStartApproval } from '../../services/jobs/PrintJobMachine';
import { getPrintJobRepository } from '../../services/jobs/AsyncStorageJobStorage';
import type { PrintJob } from '../../services/jobs/PrintJobTypes';
import StartApprovalDialog, {
  type StartApprovalResult,
} from '../../components/StartApprovalDialog';

const MW_DESIGN_RE = /(?:https?:\/\/)?(?:www\.)?makerworld\.com\/(?:\w+\/)?models\/(\d+)/i;
// The specific print profile/instance the user is viewing, e.g.
// ...#profileId-109644 or ...?profileId=109644 — this is the actual instance id
// to download (NOT the design's defaultInstanceId, which may be gated).
const MW_INSTANCE_RE = /profileId[-=](\d+)/i;

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; status: NativeSlicerStatus }
  | { state: 'error'; message: string };

type DownloadState =
  | { state: 'idle'; message: string }
  | { state: 'downloading'; message: string }
  | { state: 'success'; message: string; result: NativeMakerWorldDownload }
  | { state: 'error'; message: string };

type SliceState =
  | { state: 'idle' }
  | { state: 'slicing'; percentage: number; stage: string }
  | { state: 'success'; result: NativeSliceResult }
  | { state: 'error'; message: string };

type UploadState =
  | { state: 'idle' }
  | { state: 'uploading'; message: string }
  | { state: 'done'; message: string; filename: string; moonrakerPath: string; preview: UploadPreview; printerId: string }
  | { state: 'error'; message: string };

type UploadResult = Awaited<ReturnType<typeof uploadGcodeToPrinter>>;

type UploadPreview = {
  displayName: string;
  thumbnail: string | null;
};

type PrintStartState =
  | { state: 'idle' }
  | { state: 'starting'; message: string }
  | { state: 'done'; message: string }
  | { state: 'error'; message: string };

/**
 * Everything the start gate will be asked to re-check.
 *
 * Held as one object rather than as loose state because these values only mean
 * anything together: the job binds to the review's hash, which describes the
 * bytes behind the fingerprint, which the printer must still be holding. Losing
 * one of them would leave an approval that validates against nothing.
 */
type ApprovalState =
  | { state: 'idle' }
  | {
      state: 'awaiting';
      job: PrintJob;
      review: SliceReview;
      filename: string;
      uploaded: UploadedFileFingerprint;
      prefs: Readonly<Record<PrintPref, boolean>>;
    };

type ToolLoadStatus = 'loaded' | 'empty' | 'busy' | 'unknown';

type ToolLoadSlot = {
  index: number;
  status: ToolLoadStatus;
};

type ToolLoadInfo = {
  source: 'printer' | 'ace' | 'sensor' | 'unknown';
  slots: ToolLoadSlot[];
  firstLoaded: number | null;
  selectedTool: number;
  loadedToolMask: number;
  nativeLoadedToolMask: number;
  known: boolean;
  blockReason: string | null;
};

const EXTRACT_SAYINGS = [
  'Slicing the un-sliceable…',
  'Convincing triangles to behave…',
  'Aligning the molecular lattice…',
  'Counting layers like sheep…',
  'Polishing vertices to a shine…',
  'Negotiating with the build plate…',
  'Bribing the extruder…',
  'Untangling the spaghetti code…',
  'Consulting the print gods…',
  'Hammering pixels into plastic…',
];

export default function SliceLabScreen() {
  const router = useRouter();
  const [result, setResult] = useState<LoadState>({ state: 'loading' });
  const [sharedLink, setSharedLink] = useState<SharedMakerWorldLink | null>(null);
  const [download, setDownload] = useState<DownloadState>({
    state: 'idle',
    message: 'Share a MakerWorld model link to start import.',
  });
  const [refreshing, setRefreshing] = useState(false);
  const [slice, setSlice] = useState<SliceState>({ state: 'idle' });
  const [upload, setUpload] = useState<UploadState>({ state: 'idle' });
  const [printStart, setPrintStart] = useState<PrintStartState>({ state: 'idle' });
  const [mwAuthed, setMwAuthed] = useState(false);
  const [plates, setPlates] = useState<ModelPlate[]>([]);
  const [selectedPlate, setSelectedPlate] = useState<{ id: number; name: string } | null>(null);
  const [platesFor, setPlatesFor] = useState<string | null>(null);
  // What retargeting the current model for the U1 changed. Null when the file
  // needed none — a mesh, or a 3MF with no foreign machine profile.
  const [prepareReport, setPrepareReport] = useState<ConversionReport | null>(null);
  // The colours this project was designed in, and the operator's choice of
  // toolhead for each. Choices are kept apart from the plan so a live printer
  // update re-judges the mapping without discarding what the operator picked.
  const [projectFilaments, setProjectFilaments] = useState<ProjectFilament[]>([]);
  const [filamentChoices, setFilamentChoices] = useState<Record<number, number | null>>({});
  // Confirmation is stored against the mapping hash it was given for, so a
  // spool swapped at the printer silently invalidates it — the same rule
  // `PrintJobMachine` applies to a start approval.
  const [mappingConfirmed, setMappingConfirmed] = useState<{ at: number; hash: string } | null>(
    null
  );
  // What was read back out of the sliced G-code, including the SHA-256 a start
  // approval will bind to. Null until a slice exists and has been read.
  const [sliceReview, setSliceReview] = useState<SliceReview | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState<{ percent: number; phase: string } | null>(null);
  const [sayingIdx, setSayingIdx] = useState(0);
  // When the user remaps a single-material slice to a different loaded slot in
  // the print dialog, this holds { fileTool -> chosenLoadedSlot }. Print then
  // re-slices: if every file tool routes to the SAME slot the model is collapsed
  // to single-material; otherwise each colour is remapped to its own slot
  // (multi-colour stays multi-colour). null = use the sliced tools as-is.
  const [toolRemap, setToolRemap] = useState<Record<number, number> | null>(null);
  const [preprocessOpen, setPreprocessOpen] = useState(false);
  // The uploaded-and-waiting job. Nothing here can move the printer; reaching
  // motion needs `startApprovedPrint`, which re-checks all of it against the
  // machine first.
  const [approval, setApproval] = useState<ApprovalState>({ state: 'idle' });
  const [sendProgress, setSendProgress] = useState(0);
  const [perToolGrams, setPerToolGrams] = useState<number[]>([]);
  const [printPrefs, setPrintPrefs] = useState<Record<PrintPref, boolean>>({
    flowCal: false,
    timelapse: false,
    autoLevel: false,
  });
  const handledUrlRef = useRef<string | null>(null);
  const awaitingInteractive = useRef(false);
  const { activeUrl, connection, status, objectList } = useMoonraker();
  const ace = useACE();
  const { settings, update: updateSettings, loaded: settingsLoaded } = useSettings();
  const selectedPrinter = settings.printers.find((printer) => printer.id === settings.activePrinterId);
  const selectedPrinterUrl = selectedPrinter ? printerConnectionUrl(selectedPrinter) : '';
  const toolLoad = useMemo(
    () => resolveToolLoad(status, objectList, ace.units, ace.hardwareDetected, connection),
    [status, objectList, ace.units, ace.hardwareDetected, connection],
  );
  // What is physically on each of the four toolheads, right now.
  const loadedSlots = useMemo(
    () => readLoadedSlots(status.print_task_config, ace.headSources),
    [status.print_task_config, ace.headSources],
  );
  const filamentSlots = useMemo(
    () => resolveFilamentSlots(
      status,
      settings.filamentSlotColors,
      settings.filamentSlotBrands,
      settings.filamentSlotMaterials,
      toolLoad,
    ),
    [status, settings.filamentSlotColors, settings.filamentSlotBrands, settings.filamentSlotMaterials, toolLoad],
  );
  const effectiveFilamentSlotColors = useMemo(
    () => filamentSlots.map((slot) => slot.color),
    [filamentSlots],
  );

  /**
   * The proposed mapping, re-judged whenever the printer or a choice changes.
   *
   * Built unconfirmed. The stored confirmation is only honoured while it still
   * matches the mapping's hash, so swapping a spool at the printer withdraws it
   * without anyone having to notice — the same binding rule a start approval
   * uses in `PrintJobMachine`.
   */
  const filamentPlan = useMemo(() => {
    if (projectFilaments.length === 0) return null;
    const proposal = planFilamentMapping(projectFilaments, loadedSlots, {
      choices: filamentChoices,
    });
    const confirmedAt =
      mappingConfirmed && mappingConfirmed.hash === proposal.mapHash
        ? mappingConfirmed.at
        : null;
    return {
      ...proposal,
      mapping: { ...proposal.mapping, confirmedAt },
    };
  }, [projectFilaments, loadedSlots, filamentChoices, mappingConfirmed]);

  const chooseToolhead = useCallback((sourceIndex: number, toolhead: number | null) => {
    // Changing the mapping withdraws any confirmation; re-confirming is the
    // operator saying yes to the new one, not the old one.
    setMappingConfirmed(null);
    setFilamentChoices((current) => ({ ...current, [sourceIndex]: toolhead }));
  }, []);

  const confirmMapping = useCallback(() => {
    if (!filamentPlan?.ok) return;
    setMappingConfirmed({ at: Date.now(), hash: filamentPlan.mapHash });
  }, [filamentPlan]);


  // Keep native paint/preview prefs aligned with the saved slot colours.
  useEffect(() => {
    if (!settingsLoaded) return;
    setFilamentSlotColors(effectiveFilamentSlotColors).catch(() => {});
  }, [settingsLoaded, effectiveFilamentSlotColors]);

  // Rotate the playful "sayings" while the prepare overlay is up so there's
  // always motion even between native progress ticks.
  useEffect(() => {
    if (!extracting) return;
    const id = setInterval(() => setSayingIdx((i) => (i + 1) % EXTRACT_SAYINGS.length), 2400);
    return () => clearInterval(id);
  }, [extracting]);

  // Mirror the printer list for the native print dialog's printer picker.
  useEffect(() => {
    if (!settingsLoaded) return;
    setNativePrinters(
      settings.printers
        .map((p) => ({ name: p.name, url: printerConnectionUrl(p) }))
        .filter((p) => p.url),
    ).catch(() => {});
  }, [settingsLoaded, settings.printers]);

  const normalizePath = (p: string) => p.replace(/^file:\/\//, '');

  const syncLastSlice = useCallback(async (modelPath: string | null) => {
    if (!modelPath) return;
    try {
      const last = await getLastSliceResult();
      if (last && normalizePath(last.modelPath ?? '') === normalizePath(modelPath)) {
        setSlice({ state: 'success', result: last });
      }
    } catch {
      // Native bridge unavailable — ignore.
    }
  }, []);

  /** Drops everything derived from the previously loaded model. */
  const resetForNewModel = useCallback(() => {
    handledUrlRef.current = null;
    awaitingInteractive.current = false;
    clearLastSlice().catch(() => {});
    setSlice({ state: 'idle' });
    setUpload({ state: 'idle' });
    setPrintStart({ state: 'idle' });
    setPlates([]);
    setSelectedPlate(null);
    setPlatesFor(null);
    setPrepareReport(null);
    setProjectFilaments([]);
    setFilamentChoices({});
    setMappingConfirmed(null);
  }, []);

  /**
   * The one gate every model passes through before this screen will touch it.
   *
   * Helix has four doors into the Slice tab — the file picker, an Android share,
   * an open-with intent, and a MakerWorld download — and until Phase 4 each one
   * set the model directly, so an untrusted archive reached the native slicer
   * with nothing having looked inside it. `ImportCoordinator` is now the only
   * way in: it sanitises the name, scans the archive index, checks there is
   * geometry to slice, and records the file under its SHA-256.
   *
   * A refused file is shown as a refusal rather than quietly dropped, and the
   * previous model is cleared either way — leaving the last one on screen after
   * the operator opened a different file would be showing them something other
   * than what they chose.
   */
  const admitFile = useCallback(
    async (
      file: SharedModelFile,
      sourceKind: ImportSourceKind,
      extra?: {
        knownSha256?: string;
        attribution?: ImportAttribution;
        designId?: string | null;
        instanceId?: string | null;
      }
    ) => {
      resetForNewModel();
      setDownload({ state: 'downloading', message: `Checking ${file.fileName}…` });

      const outcome = await getImportCoordinator().import({
        filePath: file.filePath,
        fileName: file.fileName,
        sourceKind,
        ...(extra?.knownSha256 ? { knownSha256: extra.knownSha256 } : {}),
        ...(extra?.attribution ? { attribution: extra.attribution } : {}),
      });

      if (outcome.status === 'rejected') {
        setDownload({ state: 'error', message: outcome.message });
        Alert.alert('Import blocked', outcome.message);
        return;
      }

      const { record } = outcome;

      // Retarget for the U1 before anything can slice it. A downloaded project
      // describes another machine's bed, build height, motion limits and
      // start/end G-code, and `CLAUDE.md` forbids any of that surviving. This
      // happens at import rather than at slice time so both slice callers — the
      // RN bridge and the prepare screen's own Slice button — get the prepared
      // file, with no way to route around it.
      setDownload({ state: 'downloading', message: `Retargeting ${record.fileName} for the U1…` });
      const prepared = await runU1Preparation(
        {
          filePath: record.filePath,
          isArchive: record.fileKind === '3mf',
          ...(record.contents ? { slicedOutputPaths: record.contents.slicedOutputPaths } : {}),
        },
        nativePrepareIo
      );

      if (prepared.status === 'failed') {
        // No fallback to the unprepared file: it still carries the source
        // machine's G-code, so using it would be exactly what the safety rules
        // forbid.
        setPrepareReport(null);
        setDownload({ state: 'error', message: prepared.message });
        Alert.alert('Could not retarget for the U1', prepared.message);
        return;
      }

      const report = prepared.status === 'prepared' ? prepared.report : null;
      setPrepareReport(report);

      // The colours this project was designed in, read back from the prepared
      // file so the mapping is judged against the same bytes that get sliced.
      try {
        const settingsText = await readProjectSettings(prepared.filePath);
        setProjectFilaments(
          settingsText ? readProjectFilaments(JSON.parse(settingsText) as unknown) : []
        );
      } catch {
        // A project whose filament list cannot be read gets no mapping card
        // rather than an empty one implying it has no colours.
        setProjectFilaments([]);
      }

      const notes = [
        ...record.notices.map((item) => item.message),
        ...(report ? [summarizeReport(report)] : []),
      ].filter((line): line is string => Boolean(line));

      setDownload({
        state: 'success',
        message: [`Opened ${record.fileName}.`, ...notes].join(' '),
        result: {
          designId: extra?.designId ?? null,
          instanceId: extra?.instanceId ?? null,
          fileName: record.fileName,
          filePath: prepared.filePath,
          sizeBytes: record.sizeBytes,
        },
      });
    },
    [resetForNewModel]
  );

  /** Fire-and-forget wrapper, for the callers that cannot await. */
  const admitOpenedFile = useCallback(
    (openedFile: SharedModelFile) => {
      void admitFile(openedFile, detectImportSourceFromPath(openedFile.filePath));
    },
    [admitFile]
  );

  const pickLocalModel = useCallback(async () => {
    try {
      const file = await pickModelFile();
      await admitFile(file, 'file-picker');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message)) return;
      Alert.alert('Upload', message);
    }
  }, [admitFile]);

  const clearModel = useCallback(() => {
    resetForNewModel();
    setDownload({ state: 'idle', message: '' });
  }, [resetForNewModel]);

  // Open-with can finish importing after the Slice tab first paints — subscribe
  // so we still show the model when the native handoff lands late.
  useEffect(() => subscribePendingModel(admitOpenedFile), [admitOpenedFile]);

  // Re-check MakerWorld login + pick up interactive downloads / native slice results.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const pending = takeMwDownload();
      if (pending) {
        // Both MakerWorld screens hand off here — the Explore tab and the older
        // interactive download screen — so this is where either one's file is
        // scanned. Explore already hashed what it wrote and sends the digest
        // along; the older screen does not, and the import hashes for itself.
        void admitFile(
          {
            fileName: pending.fileName,
            filePath: pending.filePath,
            sizeBytes: pending.sizeBytes,
          },
          'makerworld',
          {
            ...(pending.sha256 ? { knownSha256: pending.sha256 } : {}),
            designId: pending.designId || null,
            instanceId: pending.instanceId || null,
            attribution: {
              provider: 'makerworld',
              modelId: pending.designId || null,
              profileId: pending.instanceId || null,
              title: pending.attribution?.title ?? null,
              creator: pending.attribution?.creator ?? null,
              licence: pending.attribution?.licence ?? null,
              pageUrl: pending.attribution?.pageUrl ?? null,
            },
          }
        );
      } else if (awaitingInteractive.current) {
        awaitingInteractive.current = false;
        handledUrlRef.current = null;
        setDownload({
          state: 'idle',
          message: 'Import cancelled. Share a MakerWorld link to try again.',
        });
      } else {
        const openedFile = takePendingModel();
        if (openedFile) admitOpenedFile(openedFile);
      }
      getMakerWorldCookies()
        .then((c) => active && setMwAuthed(c.hasAuth))
        .catch(() => {});
      if (download.state === 'success') {
        syncLastSlice(download.result.filePath);
      }
      return () => {
        active = false;
      };
    }, [admitFile, admitOpenedFile, syncLastSlice, download])
  );

  const checkStatus = useCallback(async () => {
    try {
      const [status, share] = await Promise.all([
        getNativeSlicerStatus(),
        getSharedMakerWorldLink(),
      ]);
      setResult({ state: 'ready', status });
      setSharedLink(share);
    } catch (error) {
      setResult({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const startDownload = useCallback(async (url: string, force = false) => {
    if (!force && handledUrlRef.current === url) return;
    handledUrlRef.current = url;
    setSlice({ state: 'idle' });
    setUpload({ state: 'idle' });
    setPrintStart({ state: 'idle' });
    clearLastSlice().catch(() => {});
    setDownload({ state: 'downloading', message: 'Opening MakerWorld…' });
    try {
      const designId = MW_DESIGN_RE.exec(url)?.[1];
      if (!designId) throw new Error('Not a MakerWorld model link.');
      const instanceId = MW_INSTANCE_RE.exec(url)?.[1] ?? '';
      const startUrl = `https://makerworld.com/en/models/${designId}${instanceId ? `#profileId-${instanceId}` : ''}`;
      const r = await openMakerWorldDownloader(designId, instanceId || null, startUrl);
      const downloaded: NativeMakerWorldDownload = {
        ...r,
        designId: r.designId ?? designId,
        instanceId: r.instanceId ?? instanceId,
      };
      setDownload({
        state: 'success',
        message: 'Model ready.',
        result: downloaded,
      });
    } catch (error) {
      handledUrlRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = message.includes('closed before a file');
      setDownload({
        state: cancelled ? 'idle' : 'error',
        message: cancelled
          ? "Import cancelled. Tap Import Link and use MakerWorld's Download button."
          : message,
      });
    }
    return;
    /*
    setDownload({ state: 'downloading', message: 'Resolving via logged-in page...' });
    try {
      const designId = MW_DESIGN_RE.exec(url)?.[1];
      if (!designId) throw new Error('Not a MakerWorld model link.');
      if (!fetcherRef.current) throw new Error('Fetcher not ready.');
      const instanceId = MW_INSTANCE_RE.exec(url)?.[1] ?? '';

      // Ask the logged-in WebView page to fetch the download URL in-origin,
      // preferring the instance from the shared link.
      const r = await fetcherRef.current.resolve(designId, instanceId);
      if (r.err) throw new Error(`In-page fetch failed: ${r.err}`);

      let signedUrl = r.fileUrl ?? '';
      let fileName = r.fileName || `makerworld_${designId}.3mf`;
      if (!signedUrl && r.body) {
        try {
          const parsed = JSON.parse(r.body);
          if (parsed.url) signedUrl = parsed.url;
          if (parsed.name) fileName = parsed.name;
        } catch {
          // body wasn't JSON
        }
      }

      if (!signedUrl) {
        // Headless fetch hit a CAPTCHA / bot-check (MakerWorld throws GeeTest at
        // API requests). Fall back to the interactive page where the user solves
        // it once and we intercept the resulting file.
        const captcha = /not a robot|captcha|geetest/i.test(r.body ?? '') || r.status === 418;
        if (captcha) {
          awaitingInteractive.current = true;
          setDownload({
            state: 'downloading',
            message: 'MakerWorld needs a human check — opening the page. Tap its Download button.',
          });
          // Pass only clean numeric ids — a raw URL param (with ?/#) breaks
          // expo-router navigation and the modal silently never opens.
          router.push({
            pathname: '/makerworld-download',
            params: { designId, instanceId },
          });
          return;
        }
        throw new Error(
          `No download URL found.\n[design=${designId} designStatus=${r.designStatus} dlStatus=${r.status} inst=${r.instance}]\n[body]: ${(r.body ?? '').slice(0, 200)}`
        );
      }

      // Signed CDN URLs are pre-authorized — plain download, no auth needed.
      setDownload({ state: 'downloading', message: `Downloading ${fileName}...` });
      const baseDir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '';
      const targetUri = `${baseDir}makerworld_${designId}.3mf`;
      await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
      const file = await FileSystem.downloadAsync(signedUrl, targetUri);
      const info = await FileSystem.getInfoAsync(file.uri);
      if (!info.exists || !info.size) throw new Error('Downloaded file is empty.');

      setDownload({
        state: 'success',
        message: 'Downloaded 3MF into Helix app storage.',
        result: {
          designId,
          instanceId: r.instance ?? designId,
          fileName,
          filePath: file.uri.replace(/^file:\/\//, ''),
          sizeBytes: info.size,
        },
      });
    } catch (error) {
      handledUrlRef.current = null;
      setDownload({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    */
  }, []);

  useEffect(() => {
    if (sharedLink?.makerWorldUrl) {
      startDownload(sharedLink.makerWorldUrl);
    }
  }, [sharedLink?.makerWorldUrl, startDownload]);

  const startUpload = useCallback(
    async (gcodePath: string, sourceName?: string | null, thenPreprocess = false) => {
      setUpload({ state: 'uploading', message: `Uploading to ${activeUrl || 'printer'}...` });
      setPrintStart({ state: 'idle' });
      try {
        if (!activeUrl) throw new Error('Printer URL is blank.');
        const requestedName = buildPrinterUploadFilename(sourceName, gcodePath);
        const uploaded = await uploadGcodeToPrinter(activeUrl, requestedName, gcodePath);
        const uploadedName = uploaded && 'filename' in uploaded ? uploaded.filename : requestedName;
        const moonrakerPath = uploadedPathFromResponse(uploaded, uploadedName);
        setUpload({ state: 'uploading', message: `Checking printer file list for ${moonrakerPath}...` });
        const verifiedPath = await verifyUploadedGcode(activeUrl, moonrakerPath, uploadedName);
        setUpload({ state: 'uploading', message: `Reading metadata for ${verifiedPath}...` });
        const preview = await readUploadedPreview(activeUrl, verifiedPath);
        setUpload({
          state: 'done',
          message: `Uploaded ${verifiedPath}`,
          filename: uploadedName,
          moonrakerPath: verifiedPath,
          preview,
          printerId: settings.activePrinterId,
        });
        // "Upload & Print" flows straight into the Print Preprocessing dialog.
        if (thenPreprocess) {
          setPrintStart({ state: 'idle' });
          setPreprocessOpen(true);
        }
      } catch (error) {
        setUpload({
          state: 'error',
          message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [activeUrl, settings.activePrinterId]
  );

  // Detect multi-plate 3MFs once per imported file, so the user can pick a plate.
  const modelFilePath = download.state === 'success' ? download.result.filePath : null;
  useEffect(() => {
    let active = true;
    if (!modelFilePath) {
      setPlates([]);
      setSelectedPlate(null);
      setPlatesFor(null);
      return;
    }
    if (platesFor === modelFilePath) return;
    getModelPlates(modelFilePath)
      .then((found) => {
        if (!active) return;
        setPlatesFor(modelFilePath);
        setPlates(found.length > 1 ? found : []);
        setSelectedPlate(null);
      })
      .catch(() => {
        if (!active) return;
        setPlates([]);
        setSelectedPlate(null);
      });
    return () => {
      active = false;
    };
  }, [modelFilePath, platesFor]);

  const choosePlate = useCallback(
    (plate: ModelPlate) => {
      if (selectedPlate?.id === plate.id) return;
      // Selection only — extraction happens in prepareAndSlice so tapping a
      // plate card is instant instead of blocking on the native repack.
      setSelectedPlate({ id: plate.id, name: plate.name });
      setSlice({ state: 'idle' });
      setUpload({ state: 'idle' });
      setPrintStart({ state: 'idle' });
    },
    [selectedPlate],
  );

  const prepareAndSlice = useCallback(async () => {
    if (download.state !== 'success') return;
    if (plates.length > 1 && !selectedPlate) {
      Alert.alert('Plates', 'This model has multiple plates — pick one to slice first.');
      return;
    }
    if (toolLoad.blockReason) {
      Alert.alert('Filament', toolLoad.blockReason);
      return;
    }
    let path = download.result.filePath;
    let title = download.result.fileName;
    setExtracting(true);
    const sub = addExtractProgressListener((p) => setExtractProgress(p));
    // Yield one frame so React paints the overlay BEFORE the (possibly very
    // fast) native extraction + activity launch. Without this, the native call
    // resolves and the Activity covers the screen before the overlay ever
    // renders — so the user only sees a dulled button, never the progress bar.
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      if (selectedPlate) {
        const extracted = await extractModelPlate(download.result.filePath, selectedPlate.id);
        path = extracted.filePath;
        title = `${download.result.fileName} — ${selectedPlate.name}`;
        setExtractProgress({ percent: 100, phase: 'Opening slicer…' });
      }
      const materialProfiles = await resolveNativeMaterialProfiles(
        connection === 'connected' ? activeUrl : null,
        filamentSlots,
      );
      await openNativeModelPreview(
        path,
        title,
        effectiveFilamentSlotColors,
        colors.primary,
        connection === 'connected' ? activeUrl : null,
        toolLoad.selectedTool,
        toolLoad.nativeLoadedToolMask,
        Boolean(selectedPlate),
        materialProfiles,
      );
    } catch (error) {
      Alert.alert('Prepare & Slice', error instanceof Error ? error.message : String(error));
    } finally {
      sub.remove();
      setExtractProgress(null);
      setExtracting(false);
    }
  }, [activeUrl, connection, download, effectiveFilamentSlotColors, filamentSlots, toolLoad, plates, selectedPlate]);

  const updateFilamentSlots = useCallback(
    async (next: string[], changedIndex?: number) => {
      const normalized = normalizeFilamentSlotColors(next);
      await updateSettings({ filamentSlotColors: normalized });
      try {
        await setFilamentSlotColors(normalized);
      } catch {
        // Native module unavailable on non-Android — settings still saved.
      }
      if (activeUrl) {
        try {
          const channels = changedIndex == null ? normalized.map((_, index) => index) : [changedIndex];
          await Promise.all(channels.map((channel) => api.setFilamentSlot(
            activeUrl,
            channel,
            {
              VENDOR: settings.filamentSlotBrands[channel] || 'Generic',
              MAIN_TYPE: settings.filamentSlotMaterials[channel] || 'PLA',
              SUB_TYPE: settings.filamentSlotSubtypes[channel] || status.filament_detect?.info?.[channel]?.SUB_TYPE || 'Basic',
              RGB_1: parseInt(normalized[channel].replace('#', '').slice(0, 6), 16),
              ALPHA: 255,
            },
          )));
        } catch (error) {
          Alert.alert('Printer update unavailable', error instanceof Error ? error.message : 'Helix saved the value locally.');
        }
      }
    },
    [activeUrl, settings.filamentSlotBrands, settings.filamentSlotMaterials, settings.filamentSlotSubtypes, status, updateSettings],
  );

  const updateFilamentMaterials = useCallback(
    async (next: string[], changedIndex?: number) => {
      const normalized = Array.from({ length: 4 }, (_, i) => {
        const value = next[i]?.trim().toUpperCase();
        return value || settings.filamentSlotMaterials[i] || 'PLA';
      });
      await updateSettings({ filamentSlotMaterials: normalized });
      if (activeUrl) {
        try {
          const channels = changedIndex == null ? normalized.map((_, index) => index) : [changedIndex];
          await Promise.all(channels.map((channel) => api.setFilamentSlot(
            activeUrl,
            channel,
            {
              VENDOR: settings.filamentSlotBrands[channel] || 'Generic',
              MAIN_TYPE: normalized[channel],
              SUB_TYPE: settings.filamentSlotSubtypes[channel] || status.filament_detect?.info?.[channel]?.SUB_TYPE || 'Basic',
              RGB_1: parseInt(normalizeFilamentSlotColors(settings.filamentSlotColors)[channel].replace('#', '').slice(0, 6), 16),
              ALPHA: 255,
            },
          )));
        } catch (error) {
          Alert.alert('Printer update unavailable', error instanceof Error ? error.message : 'Helix saved the value locally.');
        }
      }
    },
    [activeUrl, settings.filamentSlotBrands, settings.filamentSlotColors, settings.filamentSlotMaterials, settings.filamentSlotSubtypes, status, updateSettings],
  );

  const updateFilamentBrands = useCallback(
    async (next: string[], changedIndex?: number) => {
      await updateSettings({ filamentSlotBrands: next });
      const printerUrl = activeUrl || selectedPrinterUrl;
      if (printerUrl) {
        try {
          const channels = changedIndex == null ? next.map((_, index) => index) : [changedIndex];
          await Promise.all(channels.map((channel) => api.setFilamentSlot(
            printerUrl,
            channel,
            {
              VENDOR: next[channel] || 'Generic',
              MAIN_TYPE: settings.filamentSlotMaterials[channel] || 'PLA',
              SUB_TYPE: settings.filamentSlotSubtypes[channel] || status.filament_detect?.info?.[channel]?.SUB_TYPE || 'Basic',
              RGB_1: parseInt(normalizeFilamentSlotColors(settings.filamentSlotColors)[channel].replace('#', '').slice(0, 6), 16),
              ALPHA: 255,
            },
          )));
        } catch (error) {
          Alert.alert('Printer update unavailable', error instanceof Error ? error.message : 'Helix saved the value locally.');
        }
      }
    },
    [activeUrl, selectedPrinterUrl, settings.filamentSlotBrands, settings.filamentSlotColors, settings.filamentSlotMaterials, settings.filamentSlotSubtypes, status, updateSettings],
  );

  const updateFilamentSubtypes = useCallback(
    async (next: string[], changedIndex?: number) => {
      const normalized = Array.from({ length: 4 }, (_, i) => {
        const value = next[i]?.trim();
        return value || settings.filamentSlotSubtypes[i] || 'Basic';
      });
      await updateSettings({ filamentSlotSubtypes: normalized });
      const printerUrl = activeUrl || selectedPrinterUrl;
      if (printerUrl) {
        try {
          const channels = changedIndex == null ? normalized.map((_, index) => index) : [changedIndex];
          await Promise.all(channels.map((channel) => api.setFilamentSlot(
            printerUrl,
            channel,
            {
              VENDOR: settings.filamentSlotBrands[channel] || 'Generic',
              MAIN_TYPE: settings.filamentSlotMaterials[channel] || 'PLA',
              SUB_TYPE: normalized[channel],
              RGB_1: parseInt(normalizeFilamentSlotColors(settings.filamentSlotColors)[channel].replace('#', '').slice(0, 6), 16),
              ALPHA: 255,
            },
          )));
        } catch (error) {
          Alert.alert('Printer update unavailable', error instanceof Error ? error.message : 'Helix saved the value locally.');
        }
      }
    },
    [activeUrl, selectedPrinterUrl, settings.filamentSlotBrands, settings.filamentSlotColors, settings.filamentSlotMaterials, settings.filamentSlotSubtypes, updateSettings],
  );

  const openToolpathPreview = useCallback(async () => {
    if (slice.state !== 'success') return;
    const sourceName = download.state === 'success' ? download.result.fileName : null;
    const initialTool = slice.result.initialTool ?? toolLoad.selectedTool;
    try {
      await openNativeGcodePreview(
        slice.result.gcodePath,
        sourceName ?? 'Sliced toolpaths',
        colors.primary,
        connection === 'connected' ? activeUrl : null,
        initialTool,
        toolLoad.nativeLoadedToolMask,
        slice.result.usedToolMask ?? (1 << initialTool),
      );
    } catch (error) {
      Alert.alert('Toolpath Preview', error instanceof Error ? error.message : String(error));
    }
  }, [activeUrl, connection, download, slice, toolLoad]);

  const openPreprocess = useCallback(() => {
    if (slice.state !== 'success') return;
    setPrintStart({ state: 'idle' });
    setSendProgress(0);
    setPreprocessOpen(true);
  }, [slice.state]);

  // Cancel on the Send card: drop the slice result, back to the import state.
  const dismissSlice = useCallback(() => {
    setSlice({ state: 'idle' });
    setUpload({ state: 'idle' });
    setPrintStart({ state: 'idle' });
    clearLastSlice().catch(() => {});
  }, []);

  const selectPrinter = useCallback(
    (id: string) => {
      const p = settings.printers.find((x) => x.id === id);
      if (!p || p.id === settings.activePrinterId) return;
      updateSettings({
        activePrinterId: p.id,
        primaryUrl: p.url,
        tailscaleUrl: p.tailscaleUrl,
        cameraUrl: p.cameraUrl,
        connectionMode: p.connectionMode,
      });
    },
    [settings.printers, settings.activePrinterId, updateSettings],
  );

  // The dialog's button: prepare the bytes and upload them, and stop there.
  //
  // This used to slice, upload and start from one tap. `CLAUDE.md` forbids
  // starting after slicing or after upload, so the flow now ends with a file on
  // the printer and a job waiting for an operator — `confirmStart` below is the
  // only thing that reaches motion, and it re-checks everything first.
  const uploadForApproval = useCallback(async (
    requestedPrefs: Readonly<Record<PrintPref, boolean>>,
  ) => {
    if (slice.state !== 'success') return;
    if (!activeUrl) {
      setPrintStart({ state: 'error', message: 'Printer URL is blank.' });
      return;
    }
    const slicedTool = slice.result.initialTool ?? toolLoad.selectedTool;
    const fileRequiredMask = slice.result.usedToolMask ?? (1 << slicedTool);
    const fileTools = [0, 1, 2, 3].filter((t) => (fileRequiredMask & (1 << t)) !== 0);

    // Resolve the full per-file-tool target map (default identity) from toolRemap.
    const remap = toolRemap ?? {};
    const fullTarget: Record<number, number> = {};
    for (const ft of fileTools) fullTarget[ft] = remap[ft] ?? ft;
    const targets = fileTools.map((ft) => fullTarget[ft]);
    const allSameTarget = targets.length > 0 && targets.every((t) => t === targets[0]);
    const collapseSlot = allSameTarget ? targets[0] : -1;

    // Re-slice when the user routed any file tool to a different loaded slot.
    const wantsReslice =
      fileTools.some((ft) => fullTarget[ft] !== ft) &&
      Boolean(slice.result.modelPath) &&
      Boolean(slice.result.sliceSettings) &&
      Boolean(slice.result.materialProfiles);

    const requiredToolMask = wantsReslice
      ? targets.reduce((mask, t) => mask | (1 << t), 0)
      : fileRequiredMask;
    // The toolheads the print will drive are no longer sent from here: they are
    // derived from the job's filament mapping at start time, so the command the
    // printer receives comes from the same mapping the approval binds to.
    const missingTools = missingLoadedTools(toolLoad, requiredToolMask);
    if (missingTools) {
      setPrintStart({ state: 'error', message: `Load filament in ${missingTools} before printing.` });
      return;
    }

    const sourceName = download.state === 'success' ? download.result.fileName : null;
    try {
      let gcodePath = slice.result.gcodePath;
      if (wantsReslice) {
        const onResliceProgress = (percentage: number) =>
          setSendProgress(0.05 + (Math.max(0, Math.min(100, percentage)) / 100) * 0.06);
        if (allSameTarget) {
          // Collapse: every object -> one material (single-tool slice).
          const chosenMaterial =
            filamentSlots.find((s) => s.index === collapseSlot)?.material ?? `slot ${collapseSlot}`;
          setPrintStart({ state: 'starting', message: `Re-slicing for ${chosenMaterial}…` });
          setSendProgress(0.05);
          const collapsedPath = await collapseModelToTool(slice.result.modelPath as string, collapseSlot);
          const resliced = await sliceModelFile(
            collapsedPath,
            {
              initialTool: collapseSlot,
              sliceSettings: slice.result.sliceSettings,
              materialProfiles: slice.result.materialProfiles,
            },
            onResliceProgress,
          );
          if (!resliced.success || !resliced.gcodePath) {
            throw new Error(resliced.errorMessage || 'Re-slice failed.');
          }
          gcodePath = resliced.gcodePath;
        } else {
          // Per-colour remap: keep multi-colour, route each file colour to its slot.
          setPrintStart({ state: 'starting', message: 'Re-slicing per-colour…' });
          setSendProgress(0.05);
          const extruderMap: Record<number, number> = {};
          for (const ft of fileTools) extruderMap[ft + 1] = fullTarget[ft];
          const forceExtruderCount = Math.max(...targets) + 1;
          const remappedPath = await remapModelExtruders(slice.result.modelPath as string, extruderMap);
          const resliced = await sliceModelFile(
            remappedPath,
            {
              initialTool: targets[0],
              sliceSettings: slice.result.sliceSettings,
              materialProfiles: slice.result.materialProfiles,
              forceExtruderCount,
            },
            onResliceProgress,
          );
          if (!resliced.success || !resliced.gcodePath) {
            throw new Error(resliced.errorMessage || 'Re-slice failed.');
          }
          gcodePath = resliced.gcodePath;
        }
      }
      setPrintStart({ state: 'starting', message: 'Uploading…' });
      setSendProgress(0.12);
      // Timelapse is gcode-driven: the printer only records frames if the gcode
      // itself calls the TIMELAPSE_* macros at each layer. Inject them before
      // upload when the toggle is on (SET_PRINT_PREFERENCES at start time just
      // arms the firmware preference; the frame captures live in the gcode).
      let uploadPath = gcodePath;
      if (requestedPrefs.timelapse) {
        setPrintStart({ state: 'starting', message: 'Preparing timelapse…' });
        uploadPath = await injectTimelapseMacros(gcodePath);
      }

      // Review the bytes that are actually about to be sent. The card on the
      // screen describes `slice.result.gcodePath`, and a re-slice or a timelapse
      // injection has since produced a different file — binding an approval to
      // the earlier hash would bind it to bytes nobody is uploading.
      setPrintStart({ state: 'starting', message: 'Checking the G-code…' });
      const volume = buildVolumeOf(
        JSON.parse(await getU1PrinterProfile()) as Record<string, string | string[]>,
      );
      if (!volume) throw new Error('The U1 build volume could not be read, so nothing was uploaded.');
      const review = await reviewSlicedGcode(
        { filePath: uploadPath, volume, expectedPrinterModel: 'Snapmaker U1' },
        expoGcodeIo,
      );
      setSliceReview(review);
      if (!review.ok) {
        const blocking = review.findings.find((finding) => finding.severity === 'blocking');
        throw new Error(blocking?.message ?? 'This G-code did not pass review.');
      }
      setSendProgress(0.25);

      const requestedName = buildPrinterUploadFilename(sourceName, gcodePath);
      // Same stat the review used, so "the file changed since it was reviewed"
      // is judged against the same reading rather than a second opinion.
      const io = createUploadIo(activeUrl, expoGcodeIo.statFile);

      let outcome = await uploadSlicedGcode({ review, filename: requestedName }, io);
      if (outcome.status === 'needs-approval') {
        // Never overwrite without asking — the safety rules make this a
        // question, and the operator is the only one who can answer it.
        const replace = await new Promise<boolean>((resolve) => {
          Alert.alert('Replace the file on the printer?', outcome.status === 'needs-approval' ? outcome.message : '', [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Replace', style: 'destructive', onPress: () => resolve(true) },
          ]);
        });
        if (!replace) {
          setSendProgress(0);
          setPrintStart({ state: 'idle' });
          return;
        }
        outcome = await uploadSlicedGcode(
          { review, filename: requestedName, overwriteApproved: true },
          io,
        );
      }
      if (outcome.status !== 'uploaded') {
        throw new Error(outcome.status === 'refused' ? outcome.message : 'The upload did not complete.');
      }
      setSendProgress(0.8);

      // What the printer says it now holds, so the start can confirm the file
      // has not been replaced in the meantime.
      const listed = await api.listFiles(activeUrl);
      const stored = listed.find((file) => file.path === outcome.record.filename);
      const uploadedFile: UploadedFileFingerprint = {
        filename: outcome.record.filename,
        sizeBytes: stored?.size ?? outcome.record.sizeBytes,
        modified: typeof stored?.modified === 'number' ? stored.modified : null,
      };

      // The mapping the approval binds to is the one that governs these bytes:
      // each file tool against the physical toolhead it was routed to.
      const mappingSources = fileTools.map((fileTool) => {
        const project = projectFilaments.find((filament) => filament.sourceIndex === fileTool);
        return {
          sourceIndex: fileTool,
          material: project?.material ?? '',
          color: project?.color ?? '',
        };
      });
      const job = buildStartJob({
        id: newJobId(),
        modelId: sourceName ?? fileBaseName(gcodePath),
        printerId: settings.activePrinterId,
        gcodeArtifactId: uploadPath,
        gcodeSha256: review.sha256,
        uploadedFilename: uploadedFile.filename,
        filamentMapping: buildFilamentMapping(mappingSources, fullTarget, loadedSlots, Date.now()),
        at: Date.now(),
      });
      await getPrintJobRepository().save(job).catch(() => {});

      setSendProgress(1);
      setPrintStart({ state: 'idle' });
      setPreprocessOpen(false);
      setApproval({
        state: 'awaiting',
        job,
        review,
        filename: uploadedFile.filename,
        uploaded: uploadedFile,
        prefs: requestedPrefs,
      });
    } catch (error) {
      setSendProgress(0);
      setPrintStart({
        state: 'error',
        message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [
    activeUrl,
    slice,
    toolLoad,
    download,
    toolRemap,
    filamentSlots,
    loadedSlots,
    projectFilaments,
    settings.activePrinterId,
  ]);

  /**
   * The one path in this screen that can move the printer.
   *
   * Everything the operator agreed to is turned into an approval record here and
   * immediately handed to `startApprovedPrint`, which re-reads printer state,
   * the file and the loaded filament before issuing anything. Refusals report
   * every failing check rather than the first.
   */
  const confirmStart = useCallback(async (result: StartApprovalResult) => {
    if (approval.state !== 'awaiting' || !activeUrl) return;
    const { job, uploaded, review, prefs } = approval;
    setPrintStart({ state: 'starting', message: 'Checking the printer…' });

    try {
      const at = Date.now();
      const approved = grantStartApproval(
        job,
        createStartApproval({
          job,
          printerId: settings.activePrinterId,
          filename: uploaded.filename,
          gcodeSha256: review.sha256,
          approvedAt: at,
        }),
        at,
      );
      await getPrintJobRepository().save(approved).catch(() => {});

      const outcome = await startApprovedPrint(
        {
          job: approved,
          activePrinterId: settings.activePrinterId,
          uploaded,
          cameraFrame: result.cameraFrame,
          operatorConfirmedBedClear: result.bedClear,
          now: Date.now(),
        },
        createStartIo(activeUrl, { headSources: ace.headSources, prefs }),
      );
      await getPrintJobRepository().save(outcome.job).catch(() => {});

      if (outcome.status !== 'started') {
        const detail = outcome.failures.map((failure) => failure.message).join(' ');
        setPrintStart({ state: 'error', message: `${outcome.message} ${detail}`.trim() });
        // An uncertain outcome is not a refusal the operator can retry past:
        // the job is finished either way, so the approval screen closes.
        if (outcome.uncertain) setApproval({ state: 'idle' });
        return;
      }

      setPrintStart({ state: 'done', message: `Print started: ${outcome.filename}` });
      setApproval({ state: 'idle' });
      setPrintSentNotice({ filename: outcome.filename });
      // Push a concrete Home route after staging the one-shot notice. Unlike a
      // tab-level navigate to an already-mounted route, this cannot be ignored
      // as a no-op by the nested navigator.
      router.push('/');
    } catch (error) {
      setPrintStart({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [approval, activeUrl, settings.activePrinterId, ace.headSources, router]);

  const cancelApproval = useCallback(() => {
    // The file stays on the printer; only the approval is withdrawn. Nothing
    // has moved, so there is nothing to stop.
    setApproval({ state: 'idle' });
    setPrintStart({ state: 'idle' });
    setSendProgress(0);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await checkStatus();
    setRefreshing(false);
  };

  const ready = result.state === 'ready' ? result.status.loaded && !result.status.coreError : false;
  const printerReady = connection === 'connected' && Boolean(activeUrl);
  // Phase 7's review stops being advisory here: a blocking finding — a toolpath
  // off the bed, an empty file, a hash that could not be taken — now closes the
  // door to the printer rather than being shown next to an enabled button.
  const reviewBlocked = sliceReview !== null && !sliceReview.ok;
  const cameraSnapshotUrl = useMemo(
    () => resolveSnapshotUrl(undefined, settings.cameraUrl, activeUrl),
    [settings.cameraUrl, activeUrl],
  );
  const hasModel = download.state === 'success';
  const sliced = slice.state === 'success';
  const slicedInitialTool = slice.state === 'success'
    ? slice.result.initialTool ?? toolLoad.selectedTool
    : toolLoad.selectedTool;
  const slicedRequiredToolMask = slice.state === 'success'
    ? slice.result.usedToolMask ?? (1 << slicedInitialTool)
    : 1 << slicedInitialTool;
  const missingPrintTools = sliced ? missingLoadedTools(toolLoad, slicedRequiredToolMask) : null;
  const printDialogSlots = useMemo(
    () => filamentSlots.filter((slot) => (slicedRequiredToolMask & (1 << slot.index)) !== 0),
    [filamentSlots, slicedRequiredToolMask],
  );
  // Tool-remap for the print dialog: each required (file) tool defaults to
  // itself; toolRemap overrides individual tools to a different loaded slot.
  const printDialogAssignments = useMemo(() => {
    const m: Record<number, number> = {};
    for (const slot of printDialogSlots) m[slot.index] = toolRemap?.[slot.index] ?? slot.index;
    return m;
  }, [printDialogSlots, toolRemap]);

  // Pull the render thumbnail baked into the sliced gcode (shows in the card
  // immediately, before any upload — same preview the home card uses).
  const [sliceThumb, setSliceThumb] = useState<string | null>(null);
  const slicedGcodePath = slice.state === 'success' ? slice.result.gcodePath : null;
  useEffect(() => {
    let active = true;
    if (!slicedGcodePath) {
      setSliceThumb(null);
      return;
    }
    getGcodeThumbnail(slicedGcodePath)
      .then((uri) => active && setSliceThumb(uri))
      .catch(() => active && setSliceThumb(null));
    getGcodeFilamentGrams(slicedGcodePath)
      .then((g) => active && setPerToolGrams(g))
      .catch(() => active && setPerToolGrams([]));
    return () => {
      active = false;
    };
  }, [slicedGcodePath]);

  /**
   * Review whatever G-code currently exists, whichever path produced it.
   *
   * Keyed on the output path rather than hooked into each slice call site, so a
   * first slice, a per-colour re-slice and a result restored by `syncLastSlice`
   * are all reviewed the same way. It reads the finished file, after the native
   * post-processes have run, so its SHA-256 describes the bytes that would
   * actually be uploaded.
   */
  useEffect(() => {
    let active = true;
    setSliceReview(null);
    if (!slicedGcodePath) return;

    (async () => {
      const volume = buildVolumeOf(
        JSON.parse(await getU1PrinterProfile()) as Record<string, string | string[]>,
      );
      if (!volume) return;
      const review = await reviewSlicedGcode(
        { filePath: slicedGcodePath, volume, expectedPrinterModel: 'Snapmaker U1' },
        expoGcodeIo,
      );
      if (active) setSliceReview(review);
    })().catch(() => {
      // No review rather than a misleading one; the card simply does not show.
    });

    return () => {
      active = false;
    };
  }, [slicedGcodePath]);

  return (
    <>
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
    >
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Filaments</Text>
        <Text style={styles.mutedText}>T0-T3 filament colors and materials.</Text>
        <FilamentSlotsEditor
          slotColors={settings.filamentSlotColors}
          slotBrands={settings.filamentSlotBrands}
          slotMaterials={settings.filamentSlotMaterials}
          slotSubtypes={settings.filamentSlotSubtypes}
          slots={filamentSlots}
          onChange={updateFilamentSlots}
          onBrandsChange={updateFilamentBrands}
          onMaterialsChange={updateFilamentMaterials}
          onSubtypesChange={updateFilamentSubtypes}
        />
        <Text style={styles.mutedText}>
          {toolLoad.known
            ? `Single-colour slices use T${toolLoad.selectedTool}.`
            : 'Filament load is unknown until Helix can read the printer.'}
        </Text>
        {toolLoad.blockReason ? (
          <Text style={[styles.value, styles.bad]}>{toolLoad.blockReason}</Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Model</Text>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={pickLocalModel}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons name="upload" size={18} color={colors.text} />
          <Text style={styles.buttonText}>Upload .3mf / .stl</Text>
        </TouchableOpacity>
        <Text
          style={[
            styles.value,
            download.state === 'success'
              ? styles.good
              : download.state === 'error'
                ? styles.bad
                : styles.mutedValue,
          ]}
        >
          {download.message}
        </Text>
        {download.state === 'downloading' ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.body}>Importing…</Text>
          </View>
        ) : null}
        {hasModel ? (
          <View style={styles.modelFileRow}>
            <Text style={[styles.fileName, styles.modelFileName]} numberOfLines={1}>
              {download.result.fileName}
            </Text>
            <TouchableOpacity
              onPress={clearModel}
              hitSlop={8}
              accessibilityLabel="Remove model"
            >
              <MaterialCommunityIcons name="trash-can-outline" size={20} color={colors.subtext} />
            </TouchableOpacity>
          </View>
        ) : null}
        {hasModel ? <PreparationReportCard report={prepareReport} /> : null}
        {sliceReview ? <SliceReviewCard review={sliceReview} /> : null}
        {hasModel && filamentPlan ? (
          <FilamentMappingCard
            plan={filamentPlan}
            loaded={loadedSlots}
            confirmedAt={filamentPlan.mapping.confirmedAt}
            onChoose={chooseToolhead}
            onConfirm={confirmMapping}
          />
        ) : null}
        {!mwAuthed ? (
          <Text style={styles.hintText}>
            MakerWorld login is in{' '}
            <Text style={styles.hintLink} onPress={() => router.push('/settings')}>
              Settings
            </Text>
            {' '}— required to import shared models.
          </Text>
        ) : null}
        {sharedLink?.makerWorldUrl && !hasModel && download.state !== 'downloading' ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => startDownload(sharedLink.makerWorldUrl!, true)}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="download" size={18} color={colors.text} />
            <Text style={styles.buttonText}>Import from link</Text>
          </TouchableOpacity>
        ) : null}
        {hasModel && plates.length > 1 ? (
          <View style={styles.plateSection}>
            <Text style={styles.plateHeading}>
              {plates.length} plates — pick one to slice
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.plateRow}
            >
              {plates.map((plate) => {
                const active = selectedPlate?.id === plate.id;
                return (
                  <TouchableOpacity
                    key={plate.id}
                    style={[styles.plateCard, active && styles.plateCardActive]}
                    onPress={() => choosePlate(plate)}
                    disabled={extracting}
                    activeOpacity={0.85}
                  >
                    {plate.thumbnail ? (
                      <Image source={{ uri: plate.thumbnail }} style={styles.plateThumb} resizeMode="cover" />
                    ) : (
                      <View style={[styles.plateThumb, styles.platePlaceholder]}>
                        <MaterialCommunityIcons name="grid" size={22} color={colors.subtext} />
                      </View>
                    )}
                    <Text style={styles.plateName} numberOfLines={1}>{plate.name}</Text>
                    <Text style={styles.plateMeta}>
                      {plate.objectCount} obj{plate.objectCount === 1 ? '' : 's'}
                    </Text>
                    {active ? (
                      <View style={styles.plateCheck}>
                        <MaterialCommunityIcons name="check-circle" size={18} color={colors.primary} />
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        {hasModel ? (
          <TouchableOpacity
            style={[
              styles.button,
              (!ready || toolLoad.blockReason || extracting || (plates.length > 1 && !selectedPlate)) &&
                styles.buttonOff,
            ]}
            disabled={
              !ready || Boolean(toolLoad.blockReason) || extracting ||
              (plates.length > 1 && !selectedPlate)
            }
            onPress={prepareAndSlice}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="cube-scan" size={20} color={colors.text} />
            <Text style={styles.buttonText}>
              {extracting
                ? 'Preparing plate…'
                : plates.length > 1 && !selectedPlate
                  ? 'Pick a plate above'
                  : 'Prepare & Slice'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {sliced && hasModel ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Send to printer</Text>
          {sliceThumb ? (
            <Image source={{ uri: sliceThumb }} style={styles.slicePreview} resizeMode="contain" />
          ) : null}
          <Text style={styles.statsLine}>
            {slice.result.totalLayers} layers · {Math.round(slice.result.estimatedTimeSeconds / 60)} min ·{' '}
            {slice.result.estimatedFilamentGrams.toFixed(1)} g
          </Text>
          <TouchableOpacity
            style={[styles.button, (!printerReady || reviewBlocked) && styles.buttonOff]}
            disabled={!printerReady || reviewBlocked}
            onPress={openPreprocess}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="printer-3d" size={18} color={colors.text} />
            <Text style={styles.buttonText}>
              {reviewBlocked
                ? 'G-code did not pass review'
                : printerReady
                  ? 'Upload to printer'
                  : 'Printer offline'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={dismissSlice}
            activeOpacity={0.85}
          >
            <MaterialCommunityIcons name="close" size={18} color={colors.subtext} />
            <Text style={[styles.buttonText, { color: colors.subtext }]}>Cancel</Text>
          </TouchableOpacity>
          {printStart.state === 'error' ? (
            <Text style={[styles.value, styles.bad]}>{printStart.message}</Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>

    {extracting ? (
      <View style={styles.prepareOverlay}>
        <View style={styles.prepareCard}>
          <Text style={styles.prepareTitle}>
            {selectedPlate ? `Preparing ${selectedPlate.name}` : 'Preparing model'}
          </Text>
          {extractProgress ? (
            <>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.max(2, Math.min(100, extractProgress.percent))}%` },
                  ]}
                />
              </View>
              <Text style={styles.progressPct}>{extractProgress.percent}%</Text>
              <Text style={styles.preparePhase}>{extractProgress.phase}</Text>
              <Text style={styles.prepareSaying}>{EXTRACT_SAYINGS[sayingIdx]}</Text>
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.prepareSub}>Opening slicer…</Text>
            </>
          )}
        </View>
      </View>
    ) : null}

    <PrintPreprocessDialog
      visible={preprocessOpen}
      onClose={() => {
        setPreprocessOpen(false);
        setToolRemap(null);
      }}
      fileName={download.state === 'success' ? download.result.fileName : 'print.gcode'}
      estTimeSeconds={slice.state === 'success' ? slice.result.estimatedTimeSeconds : 0}
      estGramsTotal={slice.state === 'success' ? slice.result.estimatedFilamentGrams : 0}
      thumbnail={sliceThumb}
      printers={settings.printers.map((p) => ({ id: p.id, name: p.name }))}
      activePrinterId={settings.activePrinterId}
      onSelectPrinter={selectPrinter}
      slots={printDialogSlots}
      availableSlots={filamentSlots}
      assignments={printDialogAssignments}
      onAssignSlot={(_fileTool, loadedSlot) =>
        setToolRemap((prev) => ({ ...(prev ?? {}), [_fileTool]: loadedSlot }))
      }
      perToolGrams={perToolGrams}
      prefs={printPrefs}
      onTogglePref={(pref) => setPrintPrefs((prev) => ({ ...prev, [pref]: !prev[pref] }))}
      sending={printStart.state === 'starting'}
      progress={sendProgress}
      statusMessage={printStart.state === 'starting' ? printStart.message : null}
      errorMessage={printStart.state === 'error' ? printStart.message : null}
      onSend={uploadForApproval}
      sendLabel="Upload"
    />

    {approval.state === 'awaiting' ? (
      <StartApprovalDialog
        visible
        job={approval.job}
        review={approval.review}
        filename={approval.filename}
        cameraSnapshotUrl={cameraSnapshotUrl}
        cameraEndpoint={settings.cameraUrl}
        starting={printStart.state === 'starting'}
        statusMessage={printStart.state === 'starting' ? printStart.message : null}
        errorMessage={printStart.state === 'error' ? printStart.message : null}
        onCancel={cancelApproval}
        onStart={confirmStart}
      />
    ) : null}
    </>
  );
}

function buildPrinterUploadFilename(sourceName: string | null | undefined, gcodePath: string): string {
  const source = sourceName?.trim() || fileBaseName(gcodePath) || 'print';
  const stem = fileBaseName(source).replace(/\.[^.]+$/, '');
  const clean = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'print';
  return `${clean}_${Date.now()}.gcode`;
}

function uploadedPathFromResponse(uploaded: UploadResult, fallback: string): string {
  if (!uploaded) return fallback;

  try {
    const parsed = JSON.parse(uploaded.body);
    const itemPath = parsed?.item?.path;
    if (typeof itemPath === 'string' && itemPath.trim()) return itemPath;
  } catch {}

  return uploaded.filename || fallback;
}

async function readUploadedPreview(baseUrl: string, moonrakerPath: string): Promise<UploadPreview> {
  const displayName = fileBaseName(moonrakerPath).replace(/\.gcode$/i, '');

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const meta: any = await api.metadata(baseUrl, moonrakerPath);
      const thumbs: any[] = Array.isArray(meta?.thumbnails) ? meta.thumbnails : [];
      const best = thumbs.reduce(
        (winner, current) => (!winner || (current?.width ?? 0) > (winner?.width ?? 0) ? current : winner),
        null as any
      );
      if (best?.relative_path) {
        return {
          displayName,
          thumbnail: thumbnailUrl(baseUrl, moonrakerPath, best.relative_path),
        };
      }
    } catch {}

    await delay(900);
  }

  return { displayName, thumbnail: null };
}

async function verifyUploadedGcode(baseUrl: string, moonrakerPath: string, uploadedName: string): Promise<string> {
  const candidates = new Set(
    [moonrakerPath, uploadedName, fileBaseName(moonrakerPath), fileBaseName(uploadedName)].filter(Boolean)
  );
  let lastError = '';

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const files = await api.listFiles(baseUrl);
      const found = files.find((file) => {
        const path = file.path || '';
        const base = fileBaseName(path);
        return candidates.has(path) || candidates.has(base) || path.endsWith(`/${uploadedName}`);
      });
      if (found) return found.path;
      lastError = `not found in ${files.length} gcodes`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(900);
  }

  throw new Error(`Moonraker accepted the upload, but the file was not found on the printer. ${lastError}`);
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveToolLoad(
  status: Record<string, any>,
  objectList: string[],
  aceUnits: AceUnit[],
  aceHardwareDetected: boolean,
  connection: string,
): ToolLoadInfo {
  const slots: ToolLoadSlot[] = [0, 1, 2, 3].map((index) => ({ index, status: 'unknown' }));
  let source: ToolLoadInfo['source'] = 'unknown';
  let hasData = false;

  if (connection === 'connected' && Array.isArray(status.print_task_config?.filament_exist)) {
    source = 'printer';
    for (let index = 0; index < 4; index++) {
      const exists = status.print_task_config.filament_exist[index];
      if (typeof exists === 'boolean') {
        hasData = true;
        slots[index].status = exists ? 'loaded' : 'empty';
      }
    }
  }

  if (connection === 'connected' && !hasData && aceHardwareDetected) {
    source = 'ace';
    for (const unit of aceUnits) {
      for (const lane of unit.lanes) {
        if (lane.index < 0 || lane.index > 3) continue;
        const next = lane.status === 'loaded' || lane.status === 'drying'
          ? 'loaded'
          : lane.status === 'busy'
            ? 'busy'
            : lane.status === 'empty'
              ? 'empty'
              : 'unknown';
        if (next !== 'unknown') hasData = true;
        slots[lane.index].status = strongerToolStatus(slots[lane.index].status, next);
      }
    }
  }

  if (connection === 'connected' && !hasData) {
    const sensorKeys = Array.from(
      new Set(
        [...Object.keys(status), ...objectList].filter((key) =>
          /^filament_(switch|motion)_sensor /.test(key),
        ),
      ),
    );
    if (sensorKeys.length) {
      source = 'sensor';
      const booleanKeys = sensorKeys.filter((key) => typeof status[key]?.filament_detected === 'boolean');
      for (const key of booleanKeys) {
        const detected = Boolean(status[key]?.filament_detected);
        const index = toolIndexFromSensorKey(key) ?? (booleanKeys.length === 1 ? 0 : null);
        if (index == null || index < 0 || index > 3) continue;
        hasData = true;
        slots[index].status = detected ? 'loaded' : 'empty';
      }
    }
  }

  const firstLoaded = slots.find((slot) => slot.status === 'loaded')?.index ?? null;
  const loadedToolMask = slots.reduce(
    (mask, slot) => (slot.status === 'loaded' ? mask | (1 << slot.index) : mask),
    0,
  );
  const known = hasData && slots.some((slot) => slot.status !== 'unknown');
  const selectedTool = firstLoaded ?? 0;
  const blockReason = known && firstLoaded == null
    ? 'No loaded filament detected. Load a U1 head before slicing or printing.'
    : null;

  return {
    source,
    slots,
    firstLoaded,
    selectedTool,
    loadedToolMask,
    nativeLoadedToolMask: known ? loadedToolMask : -1,
    known,
    blockReason,
  };
}

function resolveFilamentSlots(
  status: Record<string, any>,
  manualColors: string[],
  manualBrands: string[],
  manualMaterials: string[],
  toolLoad: ToolLoadInfo,
): FilamentSlotDisplay[] {
  const ptc = status.print_task_config ?? {};

  return Array.from({ length: 4 }, (_, index) => {
    const loadStatus = toolLoad.slots[index]?.status ?? 'unknown';
    const printerColor = loadStatus !== 'empty'
      ? rgbaStringToHex(Array.isArray(ptc.filament_color_rgba) ? ptc.filament_color_rgba[index] : null)
      : null;
    const printerMaterial = loadStatus !== 'empty' ? materialLabelFromPrintTask(ptc, index) : '';
    const printerBrand = loadStatus !== 'empty' ? arrayString(ptc.filament_vendor, index) : '';
    const fallbackColor = normalizeFilamentSlotColors(manualColors)[index];
    const fallbackBrand = manualBrands[index] || 'Generic';
    const fallbackMaterial = manualMaterials[index] || 'PLA';
    const genericBlack = printerColor === '#000000' && !printerMaterial;
    const hasPrinterMetadata = !genericBlack && Boolean(printerColor || printerMaterial);

    return {
      index,
      status: loadStatus,
      color: loadStatus === 'empty' ? '#30343A' : (hasPrinterMetadata ? printerColor : null) ?? fallbackColor,
      brand: printerBrand && printerBrand !== 'NONE' && printerBrand !== 'GENERIC'
        ? printerBrand
        : fallbackBrand,
      material: loadStatus === 'empty' ? 'Empty' : printerMaterial || fallbackMaterial,
      source: hasPrinterMetadata ? 'printer' : 'manual',
    };
  });
}

function rgbaStringToHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value)) return null;
  return `#${value.slice(0, 6).toUpperCase()}`;
}

function materialLabelFromPrintTask(ptc: Record<string, any>, index: number): string {
  const type = arrayString(ptc.filament_type, index);
  const subType = arrayString(ptc.filament_sub_type, index);
  if (!type || type === 'NONE') return '';
  return [type, subType && subType !== 'NONE' ? subType : '']
    .filter(Boolean)
    .join(' ');
}

function arrayString(raw: unknown, index: number): string {
  if (!Array.isArray(raw)) return '';
  const value = raw[index];
  return typeof value === 'string' ? value.trim() : '';
}

function strongerToolStatus(a: ToolLoadStatus, b: ToolLoadStatus): ToolLoadStatus {
  const priority: Record<ToolLoadStatus, number> = {
    unknown: 0,
    empty: 1,
    busy: 2,
    loaded: 3,
  };
  return priority[b] > priority[a] ? b : a;
}

function toolIndexFromSensorKey(key: string): number | null {
  const tail = key.replace(/^filament_(switch|motion)_sensor\s*/i, '').toLowerCase();
  if (/^extruder$/.test(tail)) return 0;
  const named = /(?:tool|toolhead|head|slot|lane|extruder|t)[\s_-]*([0-3])\b/.exec(tail);
  if (named) return Number(named[1]);
  const lone = /(?:^|[^0-9])([0-3])(?:[^0-9]|$)/.exec(tail);
  return lone ? Number(lone[1]) : null;
}

function missingLoadedTools(toolLoad: ToolLoadInfo, requiredToolMask: number): string | null {
  if (toolLoad.nativeLoadedToolMask < 0) return null;
  const missing = (requiredToolMask & 0x0F) & ~toolLoad.loadedToolMask & 0x0F;
  return missing ? maskToTools(missing) : null;
}

function maskToTools(mask: number): string {
  return [0, 1, 2, 3]
    .filter((index) => (mask & (1 << index)) !== 0)
    .map((index) => `T${index}`)
    .join(' ');
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl + 80,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.sm,
  },
  loadingRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  prepareOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(8, 10, 12, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  prepareCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.lg,
    width: '82%',
    maxWidth: 340,
    alignItems: 'center',
    gap: spacing.md,
  },
  prepareTitle: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '800',
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  progressPct: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  preparePhase: {
    color: colors.subtext,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  prepareSaying: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 16,
    fontStyle: 'italic',
    fontWeight: '500',
    textAlign: 'center',
  },
  prepareSub: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  linkText: {
    color: colors.primary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  mutedText: {
    color: colors.subtext,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  loadedRow: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  loadedLabel: {
    color: colors.subtext,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  toolBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  toolBadge: {
    minWidth: 70,
    borderRadius: 7,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    gap: 2,
  },
  toolBadgeLoaded: {
    backgroundColor: '#13251a',
    borderColor: '#245f3b',
  },
  toolBadgeEmpty: {
    backgroundColor: '#2a1b1b',
    borderColor: '#653030',
  },
  toolBadgeBusy: {
    backgroundColor: '#332a16',
    borderColor: '#624f22',
  },
  toolBadgeUnknown: {
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
  },
  toolBadgeName: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  toolBadgeStatus: {
    color: colors.subtext,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  mutedValue: {
    color: colors.subtext,
  },
  rawText: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  previewRow: {
    minHeight: 76,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  slicePreview: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    backgroundColor: '#0d0f12',
    marginBottom: spacing.sm,
  },
  plateSection: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  plateHeading: {
    color: colors.subtext,
    fontSize: 13,
    fontWeight: '700',
  },
  plateRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
  },
  plateCard: {
    width: 104,
    borderRadius: 12,
    padding: spacing.xs,
    backgroundColor: colors.bg,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  plateCardActive: {
    borderColor: colors.primary,
  },
  plateThumb: {
    width: '100%',
    height: 88,
    borderRadius: 8,
    backgroundColor: '#0d0f12',
  },
  platePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  plateName: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  plateMeta: {
    color: colors.subtext,
    fontSize: 11,
    marginTop: 1,
  },
  plateCheck: {
    position: 'absolute',
    top: spacing.xs + 2,
    right: spacing.xs + 2,
    backgroundColor: colors.bg,
    borderRadius: 10,
  },
  previewImage: {
    width: 58,
    height: 58,
    borderRadius: 6,
    backgroundColor: colors.bg,
  },
  previewPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.border,
    borderWidth: 1,
  },
  previewText: {
    flex: 1,
    gap: 3,
  },
  previewTitle: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  previewPath: {
    color: colors.subtext,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
  row: {
    gap: 4,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: {
    color: colors.subtext,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  value: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  good: {
    color: colors.success,
  },
  bad: {
    color: colors.warning,
  },
  button: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  buttonOff: {
    opacity: 0.4,
  },
  secondaryButton: {
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  buttonText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  fileName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  modelFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  modelFileName: {
    flex: 1,
    marginTop: 0,
  },
  hintText: {
    color: colors.subtext,
    fontSize: 12,
    lineHeight: 16,
    marginTop: spacing.sm,
  },
  hintLink: {
    color: colors.primary,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  statsLine: {
    color: colors.subtext,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
});
