import { createClient } from '../client/client';
import { EmotionId, OriginalMessageType, SystemMessageDataType } from '../../typings';

import { createMusicRecognizer } from './recognizers/musicRecognizer';
import { createSpeechRecognizer } from './recognizers/speechRecognizer';
import { createVoiceListener } from './listener/voiceListener';
import { createVoicePlayer } from './player/voicePlayer';
import { resolveAudioContext, isAudioSupported } from './audioContext';

const createVoiceSettings = () => {
    let settings = { disableDubbing: false, disableListening: false };
    let scheduledSettings: Partial<typeof settings> | null = null;

    /** Применяет переданные настройки (или ранее запланированные, если сейчас ничего не передали).
     * Если установить флаг `applyNow` в `false`, то переданные настройки запланируются для
     * следующего вызова без настроек.
     * Возвращает флаг: `true` === обновили. */
    const change = (params?: { nextSettings?: Partial<typeof settings> | null; applyNow?: boolean }) => {
        const { nextSettings = null, applyNow = true } = params || {};

        if (applyNow) {
            const calculatedSettings = {
                ...settings,
                ...(scheduledSettings || {}),
                ...(nextSettings || {}),
            };
            let isUpdated = false;

            if (
                calculatedSettings.disableDubbing !== settings.disableDubbing ||
                calculatedSettings.disableListening !== settings.disableListening
            ) {
                settings = calculatedSettings;
                isUpdated = true;
            }

            scheduledSettings = null;

            return isUpdated;
        }

        scheduledSettings = {
            ...(scheduledSettings || {}),
            ...(nextSettings || {}),
        };

        return false;
    };

    /** Применяет ранее запланированные настройки в момент завершения озвучки
     * (или при прекращении слушания, если озвучка отключена). */
    const startAutoApplying = ({
        voicePlayer,
        listener,
    }: {
        voicePlayer?: ReturnType<typeof createVoicePlayer>;
        listener: ReturnType<typeof createVoiceListener>;
    }) => {
        const subscribers: Array<() => void> = [];

        if (voicePlayer) {
            subscribers.push(voicePlayer.on('end', () => change()));
        }

        subscribers.push(
            listener.on('status', (status) => {
                const isDubbingSupported = voicePlayer && !settings.disableDubbing;

                if (status === 'stopped' && !isDubbingSupported) {
                    change();
                }
            }),
        );

        return () => subscribers.forEach((unsubscribe) => unsubscribe());
    };

    return {
        change,
        startAutoApplying,
        get disableDubbing() {
            return settings.disableDubbing;
        },
        get disableListening() {
            return settings.disableListening;
        },
    };
};

export const createVoice = (
    client: ReturnType<typeof createClient>,
    emit: (event: {
        asr?: { text: string; last?: boolean; mid?: OriginalMessageType['messageId'] }; // lasr и mid нужен для отправки исх бабла в чат
        emotion?: EmotionId;
    }) => void,
    /// пока onReady не вызван, треки не воспроизводятся
    /// когда случится onReady, очередь треков начнет проигрываться
    onReady?: () => void,
) => {
    let voicePlayer: ReturnType<typeof createVoicePlayer>;
    const listener = createVoiceListener();
    const musicRecognizer = createMusicRecognizer(listener);
    const speechRecognizer = createSpeechRecognizer(listener);
    const subscriptions: Array<() => void> = [];
    const settings = createVoiceSettings();

    let isPlaying = false; // проигрывается/не проигрывается озвучка
    let autolistenMesId: string | null = null; // id сообщения, после проигрывания которого, нужно активировать слушание

    /** останавливает слушание голоса, возвращает true - если слушание было активно */
    const stopListening = (): boolean => {
        const result = speechRecognizer.status === 'active' || musicRecognizer.status === 'active';

        autolistenMesId = null;
        if (speechRecognizer.status === 'active') {
            speechRecognizer.stop();
            client.sendCancel(speechRecognizer.messageId);
            return true;
        }

        if (musicRecognizer.status === 'active') {
            musicRecognizer.stop();
            client.sendCancel(musicRecognizer.messageId);
            return true;
        }

        return result;
    };

    /** Останавливает слушание и воспроизведение */
    const stop = () => {
        // здесь важен порядок остановки голоса
        stopListening();
        voicePlayer?.stop();
    };

    /** Активирует слушание голоса
     * если было активно слушание или проигрывание - останавливает, слушание в этом случае не активируется
     */
    const listen = async ({ begin }: { begin?: ArrayBuffer[] } = {}): Promise<void> => {
        if (stopListening()) {
            return;
        }

        if (isPlaying) {
            voicePlayer?.stop();
            return;
        }

        if (settings.disableListening) {
            return;
        }

        // повторные вызовы не пройдут, пока пользователь не разрешит/запретит аудио
        if (listener.status === 'stopped') {
            return client.createVoiceStream(({ sendVoice, messageId, onMessage }) => {
                begin?.forEach((chunk) => sendVoice(new Uint8Array(chunk), false));

                return speechRecognizer.start({
                    sendVoice,
                    messageId,
                    onMessage,
                });
            });
        }
    };

    /** Активирует распознавание музыки
     * если было активно слушание или проигрывание - останавливает, распознование музыки в этом случае не активируется
     */
    const shazam = () => {
        if (stopListening()) {
            return;
        }

        if (isPlaying) {
            voicePlayer?.stop();
        }

        if (settings.disableListening) {
            return;
        }

        // повторные вызовы не пройдут, пока пользователь не разрешит/запретит аудио
        if (listener.status === 'stopped') {
            client.createVoiceStream(({ sendVoice, messageId, onMessage }) =>
                musicRecognizer.start({
                    sendVoice,
                    messageId,
                    onMessage,
                }),
            );
        }
    };

    if (isAudioSupported) {
        resolveAudioContext((context) => {
            /// создаем плеер только если поддерживается аудио
            /// и только когда готов AudioContext
            voicePlayer = createVoicePlayer(context, { startVoiceDelay: 1 });

            // начало проигрывания озвучки
            subscriptions.push(
                voicePlayer.on('play', () => {
                    isPlaying = true;
                    emit({ emotion: 'talk' });
                }),
            );

            // окончание проигрывания озвучки
            subscriptions.push(
                voicePlayer.on('end', (mesId: string) => {
                    isPlaying = false;
                    emit({ emotion: 'idle' });

                    if (mesId === autolistenMesId) {
                        listen();
                    }
                }),
            );

            // запуск автоматического применения настроек
            subscriptions.push(settings.startAutoApplying({ voicePlayer, listener }));

            // оповещаем о готовности к воспроизведению звука
            onReady && onReady();
        });
    } else {
        // запуск автоматического применения настроек (в случае, если озвучка не доступна)
        subscriptions.push(settings.startAutoApplying({ listener }));
    }

    // обработка входящей озвучки
    subscriptions.push(
        client.on('voice', (data, message) => {
            if (settings.disableDubbing) {
                return;
            }

            voicePlayer?.append(data, message.messageId.toString(), message.last === 1);
        }),
    );

    // гипотезы распознавания речи
    subscriptions.push(
        speechRecognizer.on('hypotesis', (text: string, isLast: boolean, mid: number | Long) => {
            emit({
                asr: {
                    text: listener.status === 'listen' && !settings.disableListening ? text : '',
                    last: isLast,
                    mid,
                },
            });
        }),
    );

    // статусы слушания речи
    subscriptions.push(
        listener.on('status', (status: 'listen' | 'started' | 'stopped') => {
            if (status === 'listen') {
                voicePlayer?.setActive(false);
                emit({ emotion: 'listen' });
            } else if (status === 'stopped') {
                voicePlayer?.setActive(!settings.disableDubbing);
                emit({ asr: { text: '' }, emotion: 'idle' });
            }
        }),
    );

    // активация автослушания
    subscriptions.push(
        client.on('systemMessage', (systemMessage: SystemMessageDataType, originalMessage: OriginalMessageType) => {
            const { auto_listening: autoListening } = systemMessage;

            if (autoListening) {
                /// если озвучка включена - сохраняем mesId чтобы включить слушание после озвучки
                /// если озвучка выключена - включаем слушание сразу

                if (!settings.disableDubbing) {
                    autolistenMesId = originalMessage.messageId.toString();
                } else {
                    listen();
                }
            }
        }),
    );

    return {
        destroy: () => {
            stopListening();
            voicePlayer?.setActive(false);
            subscriptions.splice(0, subscriptions.length).map((unsubscribe) => unsubscribe());
        },
        change: (nextSettings: Partial<Pick<typeof settings, 'disableDubbing' | 'disableListening'>>) => {
            const { disableDubbing, disableListening } = nextSettings;

            /// Важен порядок обработки флагов слушания и озвучки.
            /// Сначала слушание, потом озвучка
            disableListening && stopListening();
            settings.disableDubbing !== disableDubbing && voicePlayer?.setActive(!disableDubbing);

            if (listener.status === 'listen') {
                settings.change({ nextSettings, applyNow: false });
                return;
            }

            settings.change({ nextSettings });
        },
        listen,
        shazam,
        stop,
        stopPlaying: () => {
            voicePlayer?.stop();
        },
    };
};
