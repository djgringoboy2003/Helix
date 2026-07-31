import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useFocusEffect, useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, radius, spacing } from '../../constants/theme';
import { isFeatureEnabled } from '../../services/featureFlags';
import { hashFile } from '../../services/security/FileHash';
import { getMakerWorldCookies } from '../../services/nativeSlicer';
import { setMwDownload } from '../../services/mwBus';
import {
  canImportFrom,
  describeLocation,
  exploreStartUrl,
  type BrowseLocation,
} from '../../services/makerworld/BrowseNavigation';
import {
  MAKERWORLD_DOWNLOAD_HOOK,
  MAKERWORLD_LOCATION_HOOK,
  filenameFromUrl,
  isModelFileUrl,
  parseHookMessage,
  type CapturedDownload,
} from '../../services/makerworld/WebViewDownloadCapture';
import { saveCapturedDownload } from '../../services/makerworld/DownloadWriter';
import { expoDownloadIo, modelDownloadDirectory } from '../../services/makerworld/ExpoDownloadIo';
import {
  MakerWorldWebViewProvider,
  type MakerWorldWebViewBridge,
} from '../../services/makerworld/MakerWorldWebViewProvider';
import { registerModelSourceProvider, type ModelReference } from '../../services/makerworld/ModelSourceProvider';

// The Explore tab — browse MakerWorld, download a profile, hand it to Slice.
//
// `CLAUDE.md` Stage C: deliver the WebView path first, behind the provider
// interface, and hand off into the existing slicer import flow. So this screen
// owns the WebView and the operator's controls, and nothing else: every policy
// decision (allowed host, size cap, filename, hash) belongs to
// `MakerWorldWebViewProvider` and the modules under `services/makerworld/`,
// which are tested without a browser.
//
// Downloads are intercepted rather than handed to Android's download manager,
// so the file stays inside app storage and is identified by a SHA-256 taken from
// the bytes that actually landed. That hash is what a later start approval binds
// to, which is why it is computed here and not assumed.

const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Stable identity: a fresh object here would remount the WebView on every state
// update, so the page would reload each time a download progress tick arrived.
const INITIAL_SOURCE = { uri: exploreStartUrl() } as const;

type ImportState =
  | { phase: 'idle' }
  | { phase: 'downloading'; received: number; total: number | null }
  | { phase: 'verifying' }
  | { phase: 'done'; fileName: string }
  | { phase: 'error'; message: string };

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  const [location, setLocation] = useState<BrowseLocation>(() =>
    describeLocation(exploreStartUrl())
  );
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadingPage, setLoadingPage] = useState(true);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });
  const [armedModel, setArmedModel] = useState<ModelReference | null>(null);

  // Read by the bridge, which is built once and must not close over stale state.
  const locationRef = useRef(location);
  locationRef.current = location;
  const armedRef = useRef(armedModel);
  armedRef.current = armedModel;
  // Set the instant a download is intercepted, and consumed by `runDownload`.
  const captureRef = useRef<CapturedDownload | null>(null);
  const busyRef = useRef(false);

  const webViewEnabled = isFeatureEnabled('makerworld_webview_enabled');

  const bridge = useMemo<MakerWorldWebViewBridge>(
    () => ({
      hasSession: async () => (await getMakerWorldCookies()).hasAuth,
      openBrowser: async (url: string) => {
        // A string built from parsed URL parts, never raw page input.
        webRef.current?.injectJavaScript(`location.href=${JSON.stringify(url)}; true;`);
      },
      currentUrl: async () => locationRef.current.url || null,
      runDownload: async (model, onProgress) => {
        const capture = captureRef.current;
        captureRef.current = null;
        if (!capture) return null;
        const result = await saveCapturedDownload({
          capture,
          targetDirectory: modelDownloadDirectory(),
          modelId: model.modelId,
          io: expoDownloadIo,
          onProgress,
        });
        // The boundary between "bytes are on disk" and "hashing them", which is
        // the slow part on a large 3MF. Reporting it from here is what makes the
        // phase honest: the provider hashes after this returns, so setting it
        // once `downloadProfile` resolves would show it only after the wait.
        setImportState({ phase: 'verifying' });
        return result;
      },
      hashFile: async (filePath: string) => (await hashFile(filePath)).sha256,
      now: Date.now,
    }),
    []
  );

  const provider = useMemo(() => new MakerWorldWebViewProvider(bridge), [bridge]);

  // Registered so anything else that resolves a MakerWorld link — the share
  // intent, later a native provider — goes through the same interface.
  useEffect(() => {
    registerModelSourceProvider(provider);
  }, [provider]);

  /**
   * Records where the browser is, and drops a stale arming.
   *
   * Arming says which model an intercepted download belongs to. Browsing on to a
   * different model or profile has to clear it, or the next file would be
   * attributed to the page the operator armed rather than the one it came from —
   * and that attribution is what the import record is built from.
   */
  const applyLocation = useCallback((url: string) => {
    const next = describeLocation(url);
    setLocation(next);
    setArmedModel((armed) => {
      if (!armed || !next.model) return armed;
      const changed =
        next.model.modelId !== armed.modelId || next.model.profileId !== armed.profileId;
      return changed ? null : armed;
    });
  }, []);

  const refreshSession = useCallback(() => {
    getMakerWorldCookies()
      .then((cookies) => setSignedIn(cookies.hasAuth))
      .catch(() => setSignedIn(null));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshSession();
    }, [refreshSession])
  );

  const runImport = useCallback(
    async (capture: CapturedDownload) => {
      if (busyRef.current) return;
      busyRef.current = true;
      captureRef.current = capture;

      const model =
        armedRef.current ??
        locationRef.current.model ??
        fallbackReference(capture);

      setImportState({ phase: 'downloading', received: 0, total: null });
      try {
        const artifact = await provider.downloadProfile({
          model,
          targetDirectory: modelDownloadDirectory(),
          onProgress: (received, total) => {
            setImportState((current) =>
              current.phase === 'downloading' ? { phase: 'downloading', received, total } : current
            );
          },
        });

        // The provider's job ended at "bytes are on disk and here is what they
        // are". Scanning and recording them is the import's job, and that
        // happens once, on the Slice side, where every other entry point also
        // arrives. The hash travels with the handoff so it is not taken twice.
        setMwDownload({
          designId: artifact.modelId,
          instanceId: artifact.profileId ?? '',
          fileName: artifact.fileName,
          filePath: artifact.filePath,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          attribution: {
            title: artifact.source.title || null,
            creator: artifact.source.creator || null,
            licence: artifact.source.licence,
            pageUrl: artifact.source.pageUrl || null,
          },
        });
        setImportState({ phase: 'done', fileName: artifact.fileName });
        setArmedModel(null);
        router.navigate('/slicer');
      } catch (error) {
        setImportState({ phase: 'error', message: describeFailure(error) });
      } finally {
        captureRef.current = null;
        busyRef.current = false;
      }
    },
    [provider, router]
  );

  const onMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = parseHookMessage(event.nativeEvent.data);
      if (!message) return;

      if (message.kind === 'location') {
        applyLocation(message.url);
        return;
      }
      if (message.kind === 'page-error') {
        // The page failing to hand over a blob is only interesting mid-import.
        if (busyRef.current) setImportState({ phase: 'error', message: message.message });
        return;
      }
      void runImport(message);
    },
    [applyLocation, runImport]
  );

  // Some flows redirect straight to the CDN. Letting that navigation proceed
  // would drop the file outside the app, so it is turned into a managed import.
  const onShouldStartLoadWithRequest = useCallback(
    (request: WebViewNavigation): boolean => {
      if (!isModelFileUrl(request.url)) return true;
      void runImport({
        kind: 'url',
        sourceUrl: request.url,
        suggestedName: filenameFromUrl(request.url),
      });
      return false;
    },
    [runImport]
  );

  const onNavigationStateChange = useCallback(
    (state: WebViewNavigation) => {
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      applyLocation(state.url);
    },
    [applyLocation]
  );

  const importable = canImportFrom(location);
  const busy = importState.phase === 'downloading' || importState.phase === 'verifying';

  if (!webViewEnabled) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.disabled}>
          <MaterialCommunityIcons name="web-off" size={32} color={colors.subtext} />
          <Text style={styles.disabledText}>MakerWorld browsing is turned off.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.toolbar}>
        <ToolbarButton
          icon="arrow-left"
          label="Back"
          disabled={!canGoBack}
          onPress={() => webRef.current?.goBack()}
        />
        <ToolbarButton
          icon="arrow-right"
          label="Forward"
          disabled={!canGoForward}
          onPress={() => webRef.current?.goForward()}
        />
        <ToolbarButton
          icon="refresh"
          label="Refresh"
          onPress={() => webRef.current?.reload()}
        />
        <ToolbarButton
          icon="home-outline"
          label="MakerWorld"
          onPress={() => void bridge.openBrowser(exploreStartUrl())}
        />
        <ToolbarButton
          icon="open-in-new"
          label="Open in browser"
          // The page as the operator currently sees it, handed to the real
          // browser — for anything the in-app WebView cannot do, such as the
          // SSO sign-ins Google and Apple refuse to run in an embedded view.
          disabled={!location.url}
          onPress={() => {
            Linking.openURL(location.url).catch(() => {
              setImportState({
                phase: 'error',
                message: 'No browser is available to open this page.',
              });
            });
          }}
        />

        <View style={styles.locationBox}>
          <Text style={styles.locationText} numberOfLines={1}>
            {location.label}
          </Text>
          <Text style={styles.sessionText} numberOfLines={1}>
            {signedIn === null
              ? 'Session unknown'
              : signedIn
                ? 'Signed in'
                : 'Signed out — downloads need login'}
          </Text>
        </View>

        {loadingPage ? <ActivityIndicator color={colors.primary} /> : null}
      </View>

      {signedIn === false ? (
        <TouchableOpacity
          style={styles.signInBar}
          onPress={() => router.push('/makerworld-login')}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons name="login-variant" size={16} color={colors.primary} />
          <Text style={styles.signInText}>
            Sign in to MakerWorld to download models. Use email login, not Google.
          </Text>
        </TouchableOpacity>
      ) : null}

      {importable && !busy && importState.phase !== 'done' ? (
        <View style={styles.detectBar}>
          <MaterialCommunityIcons name="cube-scan" size={16} color={colors.primary} />
          <Text style={styles.detectText} numberOfLines={2}>
            {armedModel
              ? "Ready — tap MakerWorld's own Download button. The file is captured here."
              : `${location.label} detected on this page.`}
          </Text>
          {!armedModel ? (
            <TouchableOpacity
              style={styles.detectAction}
              onPress={() => setArmedModel(location.model)}
              activeOpacity={0.85}
            >
              <Text style={styles.detectActionText}>Import</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <ImportStatus state={importState} onDismiss={() => setImportState({ phase: 'idle' })} />

      <WebView
        ref={webRef}
        source={INITIAL_SOURCE}
        userAgent={UA}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically
        setSupportMultipleWindows={false}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={MAKERWORLD_DOWNLOAD_HOOK}
        injectedJavaScript={MAKERWORLD_LOCATION_HOOK}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onNavigationStateChange={onNavigationStateChange}
        onLoadStart={() => setLoadingPage(true)}
        onLoadEnd={() => {
          setLoadingPage(false);
          refreshSession();
        }}
        style={styles.web}
      />
    </SafeAreaView>
  );
}

function ImportStatus({
  state,
  onDismiss,
}: {
  state: ImportState;
  onDismiss: () => void;
}) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'error') {
    return (
      <View style={[styles.statusBar, styles.statusError]}>
        <MaterialCommunityIcons name="alert-circle-outline" size={16} color={colors.danger} />
        <Text style={styles.statusText} numberOfLines={3}>
          {state.message}
        </Text>
        <TouchableOpacity onPress={onDismiss} hitSlop={10}>
          <MaterialCommunityIcons name="close" size={16} color={colors.subtext} />
        </TouchableOpacity>
      </View>
    );
  }

  if (state.phase === 'done') {
    return (
      <View style={[styles.statusBar, styles.statusDone]}>
        <MaterialCommunityIcons name="check-circle-outline" size={16} color={colors.success} />
        <Text style={styles.statusText} numberOfLines={2}>
          {state.fileName} imported — opening Slice.
        </Text>
      </View>
    );
  }

  const message =
    state.phase === 'verifying'
      ? 'Verifying the downloaded file…'
      : state.total
        ? `Downloading — ${Math.round((state.received / state.total) * 100)}%`
        : 'Downloading…';

  return (
    <View style={styles.statusBar}>
      <ActivityIndicator color={colors.primary} size="small" />
      <Text style={styles.statusText}>{message}</Text>
    </View>
  );
}

function ToolbarButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={8}
      style={styles.toolbarButton}
    >
      <MaterialCommunityIcons
        name={icon}
        size={20}
        color={disabled ? colors.border : colors.text}
      />
    </TouchableOpacity>
  );
}

/**
 * Attribution for a download intercepted while not on a recognised model page.
 *
 * The bytes are still hashed and policy-checked; only the model identity is
 * unknown, and it is recorded as unknown rather than guessed.
 */
function fallbackReference(capture: CapturedDownload): ModelReference {
  return {
    provider: 'makerworld-webview',
    modelId: '',
    profileId: null,
    title: capture.suggestedName,
    creator: '',
    licence: null,
    pageUrl: '',
  };
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The download failed.';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarButton: { padding: 6 },
  locationBox: { flex: 1, paddingHorizontal: spacing.xs },
  locationText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  sessionText: { color: colors.subtext, fontSize: 10, fontWeight: '700' },
  signInBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
  },
  signInText: { flex: 1, color: colors.subtext, fontSize: 12, fontWeight: '600' },
  detectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.cardAlt,
  },
  detectText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '700' },
  detectAction: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  detectActionText: { color: colors.text, fontSize: 12, fontWeight: '800' },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
  },
  statusError: { backgroundColor: colors.cardAlt },
  statusDone: { backgroundColor: colors.cardAlt },
  statusText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '600' },
  web: { flex: 1, backgroundColor: '#fff' },
  disabled: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  disabledText: { color: colors.subtext, fontSize: 13, fontWeight: '700' },
});
