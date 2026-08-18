import React, { useCallback, useRef, useState } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { checkInByCode } from '../src/api/tournaments';
import { codeFromScan } from '../src/tournaments/checkInCode';
import { successFeedback, warnFeedback } from '../src/haptics';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON (N9): event check-in, by camera or by typing.
 *
 * The organizer prints a QR and tapes it to the door. It encodes
 * `/check-in/<code>`, and the card next to it tells players they can type the
 * code instead. On the website both routes exist and neither can scan
 * anything — a browser on a laptop has no camera pointed at a poster.
 *
 * This is the one place where the phone is strictly the better client, and it
 * was the one place the app made you type. Typing still works and is kept for
 * the same reason the poster keeps it: cameras fail, and a code read off paper
 * still works.
 *
 * The code identifies the EVENT, not the player — it checks in whoever is
 * signed in on this device.
 */

export default function CheckInScreen() {
    const [permission, requestPermission] = useCameraPermissions();
    const [scanning, setScanning] = useState(false);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // A camera fires this callback many times a second; without a latch the
    // same poster would post a dozen check-ins.
    const handled = useRef(false);

    const submit = useCallback(async (wanted: string) => {
        const trimmed = wanted.trim();
        if (!trimmed) {
            setError('Enter the code from the check-in sheet');

            return;
        }

        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
            const result = await checkInByCode(trimmed);
            if (!result.success) {
                warnFeedback();
                setError(result.message ?? 'That code did not check you in');

                return;
            }

            successFeedback();
            setNotice('Checked in');
            setScanning(false);

            const tournamentId = (result as { tournament?: { id?: number } }).tournament?.id;
            if (tournamentId) {
                router.replace(`/tournament/${tournamentId}`);
            }
        } catch (err) {
            warnFeedback();
            setError(err instanceof Error ? err.message : 'That code did not check you in');
        } finally {
            setBusy(false);
            handled.current = false;
        }
    }, []);

    const startScanning = async () => {
        setError(undefined);
        if (!permission?.granted) {
            const result = await requestPermission();
            if (!result.granted) {
                setError(
                    'Camera access is off for Archon Arena. Turn it on in Settings, or type the code below.'
                );

                return;
            }
        }
        handled.current = false;
        setScanning(true);
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{ padding: spacing.md, paddingBottom: 48 }}
                keyboardShouldPersistTaps='handled'
            >
                <ErrorBanner message={error} />
                {notice ? <Text style={styles.notice}>{notice}</Text> : null}

                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Scan the check-in QR</Text>
                    <Text style={styles.hint}>
                        Point the camera at the sheet on the table. It checks in whoever is signed
                        in on this phone.
                    </Text>

                    {scanning ? (
                        <View style={styles.cameraBox}>
                            <CameraView
                                style={StyleSheet.absoluteFill}
                                facing='back'
                                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                                onBarcodeScanned={({ data }) => {
                                    if (handled.current) {
                                        return;
                                    }
                                    const scanned = codeFromScan(data);
                                    if (!scanned) {
                                        return;
                                    }
                                    handled.current = true;
                                    setCode(scanned);
                                    submit(scanned);
                                }}
                            />
                            <View style={styles.reticle} pointerEvents='none' />
                        </View>
                    ) : null}

                    <Button
                        title={scanning ? 'Stop scanning' : 'Scan a code'}
                        variant={scanning ? 'secondary' : 'primary'}
                        onPress={() => (scanning ? setScanning(false) : startScanning())}
                        style={{ marginTop: spacing.md }}
                    />
                </Card>

                <Card>
                    <Text style={styles.sectionTitle}>Or type the code</Text>
                    <Text style={styles.hint}>
                        It is printed on the card beside the QR.
                    </Text>
                    <TextField
                        value={code}
                        onChangeText={setCode}
                        placeholder='Check-in code'
                        autoCapitalize='characters'
                        onSubmitEditing={() => submit(code)}
                        containerStyle={{ marginTop: spacing.sm }}
                    />
                    <Button
                        title='Check in'
                        loading={busy}
                        disabled={!code.trim()}
                        onPress={() => submit(code)}
                    />
                </Card>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    sectionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4
    },
    hint: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 2
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.md
    },
    cameraBox: {
        height: 280,
        marginTop: spacing.md,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: '#000'
    },
    reticle: {
        position: 'absolute',
        top: '18%',
        left: '18%',
        right: '18%',
        bottom: '18%',
        borderColor: colors.brand,
        borderWidth: 2,
        borderRadius: radius.md
    }
});
