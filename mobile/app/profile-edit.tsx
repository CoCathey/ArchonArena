import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View
} from 'react-native';
import {
    fetchBio,
    fetchCosmetics,
    fetchLocation,
    fetchPreviews,
    saveBio,
    saveCosmetics,
    saveLocation,
    setPreview,
    type CosmeticSlot,
    type PreviewFeature
} from '../src/api/account';
import { useAuthStore } from '../src/stores/authStore';
import { colors, radius, spacing } from '../src/theme';
import { Button, Card, ErrorBanner, TextField } from '../src/ui/primitives';

/**
 * ARCHON (N12): the public profile a player writes about themselves, and the
 * cosmetics a member paid for.
 *
 * All of it was browser-only, which is the wrong way round: profile_cosmetics
 * is sold in the app, on the membership screen, and then could only be USED on
 * a computer.
 *
 * Locked options are shown and marked rather than hidden, exactly as the
 * server sends them. A picker that silently has fewer swatches teaches a free
 * player nothing about what membership would give them.
 */

function CosmeticPicker(props: {
    slot: CosmeticSlot;
    value?: string;
    onChange: (value: string) => void;
}) {
    const { slot } = props;
    const current = props.value ?? slot.default;

    return (
        <View style={styles.slotBlock}>
            <Text style={styles.slotLabel}>{slot.label}</Text>
            {slot.description ? <Text style={styles.hint}>{slot.description}</Text> : null}
            <View style={styles.chipRow}>
                {slot.options.map((option) => {
                    const active = current === option.id;

                    return (
                        <Pressable
                            key={option.id}
                            onPress={() => !option.locked && props.onChange(option.id)}
                            disabled={option.locked}
                            style={[
                                styles.chip,
                                active && styles.chipActive,
                                option.locked && styles.chipLocked
                            ]}
                        >
                            {option.hex ? (
                                <View
                                    style={[styles.swatch, { backgroundColor: option.hex }]}
                                />
                            ) : null}
                            <Text
                                style={[
                                    styles.chipText,
                                    active && styles.chipTextActive,
                                    option.locked && { color: colors.textFaint }
                                ]}
                            >
                                {option.label}
                                {option.locked ? ' 🔒' : ''}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

export default function ProfileEditScreen() {
    const user = useAuthStore((state) => state.user);

    const [bio, setBio] = useState('');
    const [bioMax, setBioMax] = useState(300);
    const [country, setCountry] = useState('');
    const [state, setState] = useState('');
    const [catalog, setCatalog] = useState<CosmeticSlot[]>([]);
    const [cosmetics, setCosmetics] = useState<Record<string, string | undefined>>({});
    const [previews, setPreviews] = useState<PreviewFeature[]>([]);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();

    const load = useCallback(async () => {
        setLoading(true);
        // Each panel is independent and any of them may be off on a given
        // deployment, so one failing must not blank the rest.
        const [bioResult, locationResult, cosmeticsResult, previewResult] =
            await Promise.allSettled([
                fetchBio(),
                fetchLocation(),
                fetchCosmetics(),
                fetchPreviews()
            ]);

        if (bioResult.status === 'fulfilled') {
            setBio(bioResult.value.bio ?? '');
            if (bioResult.value.maxLength) {
                setBioMax(bioResult.value.maxLength);
            }
        }
        if (locationResult.status === 'fulfilled') {
            setCountry(locationResult.value.country ?? '');
            setState(locationResult.value.state ?? '');
        }
        if (cosmeticsResult.status === 'fulfilled') {
            setCatalog(cosmeticsResult.value.catalog ?? []);
            setCosmetics(cosmeticsResult.value.cosmetics ?? {});
        }
        if (previewResult.status === 'fulfilled') {
            setPreviews(previewResult.value.previews ?? []);
        }

        setLoading(false);
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const saveAll = async () => {
        setSaving(true);
        setError(undefined);
        setNotice(undefined);

        try {
            const results = await Promise.all([
                saveBio(bio),
                saveLocation({ country: country.trim(), state: state.trim() }),
                catalog.length > 0
                    ? saveCosmetics(cosmetics)
                    : Promise.resolve({ success: true, message: undefined })
            ]);

            const failure = results.find((result) => !result.success);
            if (failure) {
                setError(failure.message ?? 'Some of that could not be saved');
                return;
            }

            setNotice('Profile saved');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save your profile');
        } finally {
            setSaving(false);
        }
    };

    const togglePreview = async (feature: PreviewFeature, enabled: boolean) => {
        setPreviews((current) =>
            current.map((entry) => (entry.id === feature.id ? { ...entry, enabled } : entry))
        );

        try {
            const result = await setPreview(feature.id, enabled);
            if (!result.success) {
                setPreviews((current) =>
                    current.map((entry) =>
                        entry.id === feature.id ? { ...entry, enabled: !enabled } : entry
                    )
                );
                setError(result.message ?? 'Could not change that preview');
            }
        } catch {
            setPreviews((current) =>
                current.map((entry) =>
                    entry.id === feature.id ? { ...entry, enabled: !enabled } : entry
                )
            );
        }
    };

    if (loading) {
        return (
            <View style={[styles.container, styles.centered]}>
                <ActivityIndicator color={colors.brand} size='large' />
            </View>
        );
    }

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
                    <Text style={styles.sectionTitle}>About you</Text>
                    <Text style={styles.hint}>
                        Shown on your public profile at /players/{user?.username ?? 'you'}.
                    </Text>
                    <TextField
                        value={bio}
                        onChangeText={(text) => setBio(text.slice(0, bioMax))}
                        placeholder='A line or two about how you play'
                        multiline
                        numberOfLines={4}
                        maxLength={bioMax}
                        autoCapitalize='sentences'
                        style={{ minHeight: 90, textAlignVertical: 'top' }}
                        containerStyle={{ marginTop: spacing.sm }}
                    />
                    <Text style={styles.counter}>
                        {bio.length} / {bioMax}
                    </Text>
                </Card>

                <Card style={{ marginBottom: spacing.md }}>
                    <Text style={styles.sectionTitle}>Where you play</Text>
                    <Text style={styles.hint}>
                        Optional, and public. It is what the regional leaderboards and the player
                        directory filter on.
                    </Text>
                    <TextField
                        label='Country'
                        value={country}
                        onChangeText={setCountry}
                        placeholder='e.g. GB'
                        autoCapitalize='characters'
                        maxLength={2}
                        containerStyle={{ marginTop: spacing.sm }}
                    />
                    <TextField
                        label='State or region'
                        value={state}
                        onChangeText={setState}
                        autoCapitalize='words'
                    />
                </Card>

                {catalog.length > 0 ? (
                    <Card style={{ marginBottom: spacing.md }}>
                        <Text style={styles.sectionTitle}>Cosmetics</Text>
                        <Text style={styles.hint}>
                            How your name looks beside everyone else's. Locked options come with
                            Archon+.
                        </Text>
                        {catalog.map((slot) => (
                            <CosmeticPicker
                                key={slot.id}
                                slot={slot}
                                value={cosmetics[slot.id]}
                                onChange={(value) =>
                                    setCosmetics((current) => ({ ...current, [slot.id]: value }))
                                }
                            />
                        ))}
                    </Card>
                ) : null}

                <Button title='Save profile' loading={saving} onPress={saveAll} />

                {previews.length > 0 ? (
                    <Card style={{ marginTop: spacing.lg }}>
                        <Text style={styles.sectionTitle}>Previews</Text>
                        <Text style={styles.hint}>
                            Features you can turn on before everyone else. They change while you
                            use them.
                        </Text>
                        {previews.map((feature) => (
                            <View key={feature.id} style={styles.previewRow}>
                                <View style={{ flex: 1, paddingRight: spacing.md }}>
                                    <Text style={styles.previewLabel}>
                                        {feature.label}
                                        {feature.stageLabel ? (
                                            <Text style={styles.previewStage}>
                                                {' '}
                                                · {feature.stageLabel}
                                            </Text>
                                        ) : null}
                                    </Text>
                                    {feature.summary ? (
                                        <Text style={styles.hint}>{feature.summary}</Text>
                                    ) : null}
                                    {!feature.available && feature.availableFrom ? (
                                        <Text style={styles.hint}>
                                            Opens{' '}
                                            {new Date(
                                                feature.availableFrom
                                            ).toLocaleDateString()}
                                            .
                                        </Text>
                                    ) : null}
                                    {feature.viaPriority ? (
                                        <Text style={styles.priority}>
                                            You have this {feature.priorityDays} days early.
                                        </Text>
                                    ) : null}
                                </View>
                                <Switch
                                    value={!!feature.enabled}
                                    disabled={!feature.available}
                                    onValueChange={(value) => togglePreview(feature, value)}
                                    trackColor={{
                                        true: colors.brandDark,
                                        false: colors.surfaceHover
                                    }}
                                    thumbColor={feature.enabled ? colors.brand : colors.textFaint}
                                />
                            </View>
                        ))}
                    </Card>
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg
    },
    centered: {
        alignItems: 'center',
        justifyContent: 'center'
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
    counter: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'right'
    },
    notice: {
        color: '#7ed494',
        fontSize: 13,
        marginBottom: spacing.md
    },
    slotBlock: {
        marginTop: spacing.md
    },
    slotLabel: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700'
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 6
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        backgroundColor: colors.bgElevated
    },
    chipActive: {
        borderColor: colors.brand,
        backgroundColor: colors.surfaceHover
    },
    chipLocked: {
        opacity: 0.55
    },
    chipText: {
        color: colors.textDim,
        fontSize: 12,
        fontWeight: '600'
    },
    chipTextActive: {
        color: colors.brand
    },
    swatch: {
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.25)'
    },
    previewRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderTopColor: colors.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        marginTop: spacing.sm
    },
    previewLabel: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600'
    },
    previewStage: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '600'
    },
    priority: {
        color: colors.brand,
        fontSize: 11,
        marginTop: 2
    }
});
