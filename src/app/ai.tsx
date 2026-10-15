import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnswerCard } from '@/components/ai-ask/answer-card';
import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import {
  ASK_EXAMPLES,
  ASK_INITIAL_STATE,
  ASK_QUESTION_MAX_CHARS,
  ASK_SERVER_ENABLED,
  FAILURE_MESSAGE_JA,
  QUESTION_PROBLEM_JA,
  REFUSAL_MESSAGE_JA,
  askAvailability,
  askReducer,
  availabilityNote,
  buildAskRequest,
  canSend,
  checkQuestion,
  hasUnfilledPlaceholder,
  isRetryable,
  makeClientRequestId,
  type AskRequest,
  type AskResponse,
  type AskScope,
} from '@/lib/ai-ask';

const palette = KABUMORI_COLORS.light;

const SCOPES: ReadonlyArray<{ scope: AskScope; label: string }> = [
  { scope: 'market', label: '市況' },
  { scope: 'holdings', label: '保有銘柄' },
  { scope: 'stock', label: '特定の銘柄' },
];

// 「AIに聞いてみる」V1 Phase A.
//
// Phase A is the dialogue UI and the typed contract only; it is NOT connected to any server or model.
//   * production build: nothing here is sendable -- no input, no example chips, no send button; the screen says
//     the feature is in preparation (same honest state as before, plus what it will be able to do);
//   * development build (__DEV__): an offline mock answers with fixed SAMPLE text, clearly bannered, so the
//     answered / refused / failed / retry / unknown-time states can be seen and tested. The mock module is loaded
//     only under __DEV__, so a production bundle neither contains nor can reach it.
// The contract the Phase B server must honour: docs/release-readiness/kabumori-app/AI_ASK_V1_PHASE_A_CONTRACT.md.
const mock = __DEV__ ? (require('@/lib/ai-ask-mock') as typeof import('@/lib/ai-ask-mock')) : null;

export default function AiScreen() {
  const availability = askAvailability({ dev: __DEV__, serverEnabled: ASK_SERVER_ENABLED });
  const [state, dispatch] = useReducer(askReducer, ASK_INITIAL_STATE);
  // Set true again on every (re)mount: an effect that only cleans up leaves the flag false after a Fast Refresh /
  // StrictMode remount, and every later answer would be dropped (the screen would stay "sending" forever).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (request: AskRequest) => {
    let response: AskResponse;
    try {
      // Phase A has no server: outside the development mock the only possible answer is "unavailable".
      response = mock ? await mock.mockAsk(request) : { status: 'failed', code: 'unavailable' };
    } catch {
      if (alive.current) dispatch({ type: 'fail', clientRequestId: request.clientRequestId, code: 'network' });
      return;
    }
    if (alive.current) dispatch({ type: 'receive', clientRequestId: request.clientRequestId, response });
  }, []);

  const check = checkQuestion(state.draft);
  const unfilled = hasUnfilledPlaceholder(state.draft);
  const tickerOk = state.scope !== 'stock' || /^([0-9]{4}|[0-9]{3}[A-Za-z])$/.test((state.tickerCode ?? '').trim());
  const sending = state.phase === 'sending';
  const sendable = canSend(availability) && check.ok && !unfilled && tickerOk && !sending;

  const send = () => {
    if (!sendable) return;
    const request = buildAskRequest({
      question: state.draft,
      scope: state.scope,
      tickerCode: state.tickerCode,
      clientRequestId: makeClientRequestId(Date.now(), Math.random),
    });
    if (!request) return;
    dispatch({ type: 'send', request });
    void run(request);
  };

  const retry = () => {
    if (state.phase !== 'failed' || !state.request) return;
    const request = state.request;
    dispatch({ type: 'retry' });
    void run(request);
  };

  const problem = state.draft.length > 0 && !check.ok ? QUESTION_PROBLEM_JA[check.reason] : unfilled ? '「〇〇」を、聞きたい内容に書き換えてください。' : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <BackButton />
          <Text style={styles.eyebrow}>ASK KABUMORI AI</Text>
          <Text style={styles.title} accessibilityRole="header">AIに聞いてみる</Text>

          <View style={[styles.note, availability === 'unavailable' ? styles.noteQuiet : styles.noteDev]} accessible accessibilityLabel={availabilityNote(availability)}>
            <Text style={styles.noteText}>{availabilityNote(availability)}</Text>
          </View>

          {availability === 'unavailable' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>公開後に、こんなことを聞けるようになります</Text>
              {ASK_EXAMPLES.map((example) => (
                <Text key={example.id} style={styles.exampleText}>・{example.question}</Text>
              ))}
              <Text style={styles.cardFoot}>回答には、もとにしたニュースやデータの時点を添えてお届けします。</Text>
            </View>
          ) : (
            <>
              <View style={styles.scopeRow} accessibilityRole="tablist">
                {SCOPES.map((item) => {
                  const selected = state.scope === item.scope;
                  return (
                    <Pressable
                      key={item.scope}
                      onPress={() => dispatch({ type: 'scope', scope: item.scope })}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      accessibilityLabel={item.label}
                      style={[styles.scopeChip, selected && styles.scopeChipOn]}>
                      <Text style={[styles.scopeText, selected && styles.scopeTextOn]}>{item.label}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {state.scope === 'stock' ? (
                <TextInput
                  value={state.tickerCode ?? ''}
                  onChangeText={(text) => dispatch({ type: 'scope', scope: 'stock', tickerCode: text.toUpperCase() })}
                  placeholder="銘柄コード（例：7203）"
                  placeholderTextColor={palette.muted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={4}
                  style={styles.ticker}
                  accessibilityLabel="銘柄コード"
                />
              ) : null}

              <View style={styles.examples}>
                {[...ASK_EXAMPLES, ...(mock ? mock.MOCK_EXAMPLES : [])].map((example) => (
                  <Pressable
                    key={example.id}
                    onPress={() => {
                      dispatch({ type: 'scope', scope: example.scope });
                      dispatch({ type: 'edit', draft: example.question });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`質問例 ${example.question}`}
                    accessibilityHint="入力欄に例を入れます。まだ送信されません"
                    style={({ pressed }) => [styles.example, pressed && styles.pressed]}>
                    <Text style={styles.exampleChip}>{example.question}</Text>
                  </Pressable>
                ))}
              </View>

              <TextInput
                value={state.draft}
                onChangeText={(text) => dispatch({ type: 'edit', draft: text })}
                placeholder="聞きたいことを入力"
                placeholderTextColor={palette.muted}
                multiline
                maxLength={ASK_QUESTION_MAX_CHARS + 20}
                style={styles.input}
                accessibilityLabel="AIへの質問"
              />
              <View style={styles.inputFoot}>
                <Text style={[styles.problem, !problem && styles.problemHidden]} accessibilityLiveRegion="polite">{problem ?? ' '}</Text>
                <Text style={styles.count}>{Array.from(state.draft).length}/{ASK_QUESTION_MAX_CHARS}</Text>
              </View>

              <Pressable
                onPress={send}
                disabled={!sendable}
                accessibilityRole="button"
                accessibilityLabel="質問を送る"
                accessibilityState={{ disabled: !sendable }}
                style={({ pressed }) => [styles.send, !sendable && styles.sendOff, pressed && sendable && styles.pressed]}>
                <Text style={styles.sendText}>{sending ? '回答を作っています…' : '質問を送る'}</Text>
              </Pressable>

              {sending ? <ActivityIndicator color={palette.accent} style={styles.spinner} accessibilityLabel="回答を作っています" /> : null}

              {state.phase === 'answered' && state.response ? <AnswerCard answer={state.response} /> : null}

              {state.phase === 'refused' && state.refusal ? (
                <View style={styles.card} accessible accessibilityLabel={REFUSAL_MESSAGE_JA[state.refusal]}>
                  <Text style={styles.refusal}>{REFUSAL_MESSAGE_JA[state.refusal]}</Text>
                </View>
              ) : null}

              {state.phase === 'failed' && state.failure ? (
                <View style={styles.errorCard} accessibilityLiveRegion="polite">
                  <Text style={styles.errorText}>{FAILURE_MESSAGE_JA[state.failure]}</Text>
                  {isRetryable(state.failure) ? (
                    <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel="もう一度試す" style={styles.retry}>
                      <Text style={styles.retryText}>もう一度試す</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40, gap: 12 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900' },
  note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  noteQuiet: { backgroundColor: palette.soft },
  noteDev: { backgroundColor: palette.warningSoft },
  noteText: { color: palette.text, fontSize: 13.5, lineHeight: 20 },
  card: { backgroundColor: palette.card, borderRadius: 18, borderWidth: 1, borderColor: palette.border, padding: 16, gap: 8 },
  cardTitle: { color: palette.text, fontSize: 15, fontWeight: '900' },
  cardFoot: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  exampleText: { color: palette.text, fontSize: 14.5, lineHeight: 22 },
  scopeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  scopeChip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, alignItems: 'center', justifyContent: 'center' },
  scopeChipOn: { backgroundColor: palette.accent, borderColor: palette.accent },
  scopeText: { color: palette.text, fontSize: 14, fontWeight: '800' },
  scopeTextOn: { color: '#ffffff' },
  ticker: { minHeight: 48, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 14, backgroundColor: palette.card, paddingHorizontal: 14, fontSize: 16, color: palette.text },
  examples: { gap: 8 },
  example: { minHeight: 44, justifyContent: 'center' },
  exampleChip: { alignSelf: 'flex-start', color: palette.accent, backgroundColor: palette.soft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, fontWeight: '700', overflow: 'hidden' },
  input: { minHeight: 96, borderWidth: 1, borderColor: palette.inputBorder, borderRadius: 16, backgroundColor: palette.card, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: 16, lineHeight: 22, color: palette.text, textAlignVertical: 'top' },
  inputFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  problem: { flex: 1, color: palette.errorText, fontSize: 12.5, lineHeight: 18 },
  problemHidden: { opacity: 0 },
  count: { color: palette.muted, fontSize: 12.5 },
  send: { minHeight: 52, borderRadius: 26, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  sendOff: { backgroundColor: '#b9c4bc' },
  sendText: { color: '#ffffff', fontSize: 16, fontWeight: '900' },
  spinner: { marginTop: 4 },
  refusal: { color: palette.text, fontSize: 14.5, lineHeight: 22 },
  errorCard: { backgroundColor: palette.errorSoft, borderRadius: 16, padding: 14, gap: 10 },
  errorText: { color: palette.errorText, fontSize: 14, lineHeight: 21 },
  retry: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  retryText: { color: '#ffffff', fontSize: 14, fontWeight: '900' },
  pressed: { opacity: 0.75 },
});
