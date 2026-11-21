package com.yuushilabs.aegis.data

import android.content.Context
import com.yuushilabs.aegis.core.Account
import com.yuushilabs.aegis.core.AppLoginPayload
import com.yuushilabs.aegis.core.Crypto
import com.yuushilabs.aegis.core.Duplicates
import com.yuushilabs.aegis.core.IsoTime
import com.yuushilabs.aegis.core.SyncCode
import com.yuushilabs.aegis.core.Tombstone
import com.yuushilabs.aegis.core.Trash
import com.yuushilabs.aegis.core.VaultData
import com.yuushilabs.aegis.core.VaultEnvelope
import com.yuushilabs.aegis.core.VaultJson
import com.yuushilabs.aegis.core.VaultMerge
import com.yuushilabs.aegis.core.VaultProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID

enum class SyncState { LOCAL_ONLY, SYNCED, PENDING, ERROR, CONFLICT }

data class ConflictState(val remoteRevision: Int, val remoteEnvelope: VaultEnvelope)

sealed interface RepoEvent {
    data class Message(val text: String, val isError: Boolean = false) : RepoEvent
    data class AppLoginDone(val vaultName: String) : RepoEvent
    data class AppLoginFailed(val reason: String) : RepoEvent
}

data class RepoState(
    val loaded: Boolean = false,
    val hasVault: Boolean = false,
    val unlocked: Boolean = false,
    val vaultName: String = "メイン",
    val accounts: List<Account> = emptyList(),
    val devices: List<com.yuushilabs.aegis.core.SyncDevice> = emptyList(),
    val profiles: List<VaultProfile> = emptyList(),
    val activeProfileId: String = "main",
    val syncEnabled: Boolean = false,
    /** 表示用の同期コード（トークンそのもの。画面で必要になったときだけ出す）。 */
    val syncCode: String? = null,
    val syncState: SyncState = SyncState.LOCAL_ONLY,
    /** 画面に出す日本語のメッセージ（`http_400` のような生コードは入れない）。 */
    val syncError: String? = null,
    /** 設定画面の「詳細」にだけ出すデバッグ情報（`http_400 revision_must_advance` など）。 */
    val syncErrorCode: String? = null,
    val lastSyncedAt: String? = null,
    val syncedRevision: Int? = null,
    val conflict: ConflictState? = null,
    val biometricEnabled: Boolean = false,
    val busy: Boolean = false,
    val settings: AegisSettings = AegisSettings(),
    val event: RepoEvent? = null,
) {
    val trashedAccounts: List<Account> get() = accounts.filter { it.isTrashed }
    val activeAccounts: List<Account> get() = accounts.filterNot { it.isTrashed }
}

/**
 * ボルトの状態と操作。UI から見えるのは [state] だけ。
 *
 * - 保存は暗号文封筒（DEK で AES-GCM）。平文の秘密鍵はメモリ（アンロック中）にだけ置く。
 * - 保存のたびに revision を進め、2 秒のデバウンスでサーバーへ PUT する（ゼロ知識）。
 * - 409 は「再取得して tombstones ごとマージ」まで自動で行わず、利用者に選ばせる
 *   （上書き / 破棄 / マージ）。
 */
class VaultRepository(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = SecureStore(appContext)
    private val settingsStore = SettingsStore(appContext)
    private val api = SyncApi()
    private val syncEngine = SyncEngine(api)
    private val writeMutex = Mutex()

    private val _state = MutableStateFlow(RepoState())
    val state: StateFlow<RepoState> = _state.asStateFlow()

    private var stored: StoredState? = null
    private var envelope: VaultEnvelope? = null
    private var dek: ByteArray? = null
    private var token: String? = null
    private var syncedRevision: Int? = null
    private var accounts: List<Account> = emptyList()
    private var tombstones: List<Tombstone> = emptyList()
    private var devices: List<com.yuushilabs.aegis.core.SyncDevice> = emptyList()
    /** Web 版が入れたパスキー名の一覧（Android では表示しないが、消さずに書き戻す）。 */
    private var passkeyInfos: List<com.yuushilabs.aegis.core.PasskeyInfo> = emptyList()
    private var syncTimer: Job? = null
    private var lastActivity: Long = System.currentTimeMillis()
    private var failedUnlocks = 0
    private var cooldownUntil = 0L

    init {
        _state.value = _state.value.copy(settings = settingsStore.load())
        scope.launch { loadFromStore() }
        scope.launch { autoLockLoop() }
    }

    fun touch() {
        lastActivity = System.currentTimeMillis()
    }

    private suspend fun loadFromStore() = withContext(Dispatchers.IO) {
        val loaded = store.load()
        stored = loaded
        val settings = settingsStore.load()
        val active = loaded?.vaults?.firstOrNull { it.id == loaded.activeVaultId }
        envelope = active?.envelope
        token = active?.token
        syncedRevision = active?.syncedRevision
        _state.value = _state.value.copy(
            loaded = true,
            hasVault = active?.envelope != null,
            unlocked = false,
            vaultName = active?.name ?: "メイン",
            profiles = loaded?.vaults?.map { VaultProfile(it.id, it.name, it.createdAt) } ?: emptyList(),
            activeProfileId = active?.id ?: "main",
            syncEnabled = active?.token != null,
            syncCode = active?.token,
            syncedRevision = active?.syncedRevision,
            syncState = when {
                active?.token == null -> SyncState.LOCAL_ONLY
                active.syncedRevision != null -> SyncState.SYNCED
                else -> SyncState.PENDING
            },
            lastSyncedAt = active?.envelope?.updatedAt,
            biometricEnabled = settings.biometricEnabled && active?.biometricWrap != null,
            settings = settings,
        )
    }

    private suspend fun autoLockLoop() {
        while (true) {
            delay(5_000)
            val settings = _state.value.settings
            if (_state.value.unlocked && settings.autoLockMinutes > 0) {
                val idleMinutes = (System.currentTimeMillis() - lastActivity) / 60_000
                if (idleMinutes >= settings.autoLockMinutes) lock()
            }
        }
    }

    // ------------------------------------------------------------------ ボルト

    suspend fun createVault(
        password: String,
        vaultName: String = "メイン",
        enableSync: Boolean = true,
    ) = withContext(Dispatchers.IO) {
        require(password.length >= Crypto.MIN_PASSWORD_LENGTH) {
            "マスターパスワードは${Crypto.MIN_PASSWORD_LENGTH}文字以上にしてください"
        }
        val name = vaultName.trim().ifEmpty { "メイン" }
        val now = IsoTime.now()
        val newDek = Crypto.generateDek()
        val data = VaultData(accounts = emptyList(), tombstones = emptyList(), devices = null)
        val newEnvelope = Crypto.createEnvelope(
            password = password,
            plaintext = VaultJson.serialize(data),
            revision = 1,
            dek = newDek,
        )
        val newToken = if (enableSync) SyncCode.generateToken() else null
        val profileId = "main"
        val vault = StoredVault(
            id = profileId,
            name = name,
            createdAt = now,
            envelope = newEnvelope,
            token = newToken,
            syncedRevision = if (newToken == null) null else 0,
        )
        stored = StoredState(version = 1, activeVaultId = profileId, vaults = listOf(vault))
        envelope = newEnvelope
        dek = newDek
        token = newToken
        syncedRevision = vault.syncedRevision
        accounts = emptyList()
        tombstones = emptyList()
        devices = emptyList()
        persistStored()
        _state.value = _state.value.copy(
            hasVault = true,
            unlocked = true,
            vaultName = name,
            accounts = emptyList(),
            devices = emptyList(),
            profiles = listOf(VaultProfile(profileId, name, now)),
            activeProfileId = profileId,
            syncEnabled = newToken != null,
            syncCode = newToken,
            syncedRevision = syncedRevision,
            syncState = if (newToken == null) SyncState.LOCAL_ONLY else SyncState.PENDING,
        )
        touch()
        if (newToken != null) scheduleSync()
    }

    suspend fun unlock(password: String): Result<Unit> = withContext(Dispatchers.IO) {
        val current = envelope ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
        if (System.currentTimeMillis() < cooldownUntil) {
            return@withContext Result.failure(IllegalStateException("しばらく待ってから入力してください"))
        }
        try {
            val unlocked = Crypto.unlock(current, password)
            dek = unlocked.dek
            failedUnlocks = 0
            val data = VaultJson.parse(unlocked.plaintext)
            applyLoadedData(data)
            _state.value = _state.value.copy(unlocked = true, busy = false)
            touch()
            persistIfTrashPurged(data)
            Result.success(Unit)
        } catch (_: Crypto.WrongPasswordException) {
            failedUnlocks += 1
            if (failedUnlocks >= 5) {
                cooldownUntil = System.currentTimeMillis() + 30_000
                failedUnlocks = 0
                return@withContext Result.failure(IllegalStateException("パスワードを5回間違えました。30秒お待ちください"))
            }
            Result.failure(IllegalStateException("パスワードが違います"))
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    private suspend fun applyLoadedData(data: VaultData) {
        val purged = Trash.purgeExpired(data.accounts, data.tombstones.orEmpty())
        accounts = VaultJson.manualSort(purged.accounts)
        tombstones = purged.tombstones
        devices = data.devices.orEmpty()
        passkeyInfos = data.passkeyInfos.orEmpty()
        _state.value = _state.value.copy(
            accounts = accounts,
            devices = devices,
            unlocked = true,
        )
    }

    private suspend fun persistIfTrashPurged(data: VaultData) {
        if (Trash.purgeExpired(data.accounts, data.tombstones.orEmpty()).purged > 0) {
            persistAndSync()
        }
    }

    suspend fun lock() = withContext(Dispatchers.IO) {
        // 保留中の同期は失わない（暗号文だけなのでロック中でも送れる）。
        syncTimer?.cancel()
        syncTimer = null
        runCatching { syncNowInternal() }
        dek?.fill(0)
        dek = null
        accounts = emptyList()
        tombstones = emptyList()
        devices = emptyList()
        passkeyInfos = emptyList()
        _state.value = _state.value.copy(
            unlocked = false,
            accounts = emptyList(),
            devices = emptyList(),
            conflict = null,
        )
    }

    fun onAppBackground() {
        val settings = _state.value.settings
        if (_state.value.unlocked && settings.lockOnHide && settings.autoLockMinutes > 0) {
            scope.launch { lock() }
        }
    }

    // ------------------------------------------------------------- 生体認証

    suspend fun enableBiometric(wrap: WrappedKey) = withContext(Dispatchers.IO) {
        val vault = activeStoredVault() ?: return@withContext
        updateStoredVault(vault.copy(biometricWrap = wrap))
        val settings = settingsStore.load().copy(biometricEnabled = true)
        settingsStore.save(settings)
        _state.value = _state.value.copy(biometricEnabled = true, settings = settings)
    }

    suspend fun disableBiometric() = withContext(Dispatchers.IO) {
        val vault = activeStoredVault() ?: return@withContext
        updateStoredVault(vault.copy(biometricWrap = null))
        val settings = settingsStore.load().copy(biometricEnabled = false)
        settingsStore.save(settings)
        _state.value = _state.value.copy(biometricEnabled = false, settings = settings)
    }

    fun biometricWrap(): WrappedKey? = activeStoredVault()?.biometricWrap

    /** 認証済みの Cipher で今の DEK をラップして保存する（生体認証の登録）。 */
    suspend fun enrollBiometric(cipher: javax.crypto.Cipher): Result<Unit> = withContext(Dispatchers.IO) {
        val currentDek = dek ?: return@withContext Result.failure(IllegalStateException("ロックされています"))
        try {
            val (iv, ciphertext) = KeystoreCrypto.wrapWithBiometricCipher(cipher, currentDek)
            enableBiometric(WrappedKey(com.yuushilabs.aegis.core.Bytes.base64(iv), com.yuushilabs.aegis.core.Bytes.base64(ciphertext)))
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(IllegalStateException("生体認証を登録できませんでした"))
        }
    }

    /** 認証済みの Cipher でラップを開いて解錠する。 */
    suspend fun unlockWithBiometric(cipher: javax.crypto.Cipher): Result<Unit> = withContext(Dispatchers.IO) {
        val wrap = biometricWrap() ?: return@withContext Result.failure(IllegalStateException("生体認証が登録されていません"))
        try {
            val raw = KeystoreCrypto.unwrapWithBiometricCipher(
                cipher,
                com.yuushilabs.aegis.core.Bytes.base64Decode(wrap.ciphertext),
            )
            unlockWithDek(raw)
        } catch (error: Exception) {
            Result.failure(IllegalStateException("生体認証で開けませんでした。マスターパスワードを入力してください"))
        }
    }

    /** 生体認証で開いた DEK をそのまま受け取って解錠する。 */
    suspend fun unlockWithDek(rawDek: ByteArray): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val current = envelope ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
            val plaintext = Crypto.decryptWithDek(current, rawDek)
            val data = VaultJson.parse(plaintext)
            dek = rawDek.copyOf()
            applyLoadedData(data)
            touch()
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(IllegalStateException("生体認証で開けませんでした。マスターパスワードを入力してください"))
        }
    }

    // ------------------------------------------------------------- アカウント

    fun findDuplicates(candidate: Account): List<com.yuushilabs.aegis.core.DuplicateMatch> =
        Duplicates.findDuplicates(accounts, candidate)

    suspend fun addAccount(account: Account): Result<Unit> = withContext(Dispatchers.IO) {
        if (!isUnlocked()) return@withContext Result.failure(IllegalStateException("ロックされています"))
        val now = IsoTime.now()
        val prepared = account.copy(
            id = account.id.ifEmpty { UUID.randomUUID().toString() },
            secret = runCatching { com.yuushilabs.aegis.core.Base32.canonical(account.secret) }
                .getOrElse { account.secret },
            order = if (account.order == 0) VaultJson.nextOrder(accounts) else account.order,
            createdAt = account.createdAt.ifEmpty { now },
            updatedAt = now,
        )
        accounts = VaultJson.manualSort(accounts + prepared)
        persistAndSync()
        Result.success(Unit)
    }

    suspend fun addAccounts(list: List<Account>): Int = withContext(Dispatchers.IO) {
        if (!isUnlocked()) return@withContext 0
        val now = IsoTime.now()
        var order = VaultJson.nextOrder(accounts)
        val prepared = list.map { account ->
            account.copy(
                id = account.id.ifEmpty { UUID.randomUUID().toString() },
                order = order++,
                createdAt = account.createdAt.ifEmpty { now },
                updatedAt = now,
            )
        }
        accounts = VaultJson.manualSort(accounts + prepared)
        persistAndSync()
        prepared.size
    }

    suspend fun updateAccount(account: Account): Result<Unit> = withContext(Dispatchers.IO) {
        if (!isUnlocked()) return@withContext Result.failure(IllegalStateException("ロックされています"))
        accounts = accounts.map { current ->
            if (current.id == account.id) {
                account.copy(
                    updatedAt = IsoTime.now(),
                    secret = runCatching { com.yuushilabs.aegis.core.Base32.canonical(account.secret) }
                        .getOrElse { account.secret },
                )
            } else {
                current
            }
        }
        accounts = VaultJson.manualSort(accounts)
        persistAndSync()
        Result.success(Unit)
    }

    suspend fun trashAccount(id: String) = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        accounts = accounts.map { if (it.id == id) it.copy(deletedAt = now, updatedAt = now) else it }
        persistAndSync()
    }

    suspend fun restoreAccount(id: String) = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        accounts = accounts.map { if (it.id == id) it.copy(deletedAt = null, updatedAt = now) else it }
        persistAndSync()
    }

    suspend fun purgeAccount(id: String) = withContext(Dispatchers.IO) {
        accounts = accounts.filterNot { it.id == id }
        tombstones = VaultMerge.mergeTombstones(tombstones, listOf(Tombstone(id, IsoTime.now())))
        persistAndSync()
    }

    suspend fun emptyTrash() = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        val removed = accounts.filter { it.isTrashed }
        accounts = accounts.filterNot { it.isTrashed }
        tombstones = VaultMerge.mergeTombstones(tombstones, removed.map { Tombstone(it.id, now) })
        persistAndSync()
    }

    suspend fun recordUse(id: String) = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        // updatedAt は変えない（他端末の新しい編集を巻き戻さない）。
        accounts = accounts.map {
            if (it.id == id) it.copy(useCount = (it.useCount ?: 0) + 1, lastUsedAt = now) else it
        }
        persistAndSync()
    }

    suspend fun advanceHotp(id: String) = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        accounts = accounts.map {
            if (it.id == id) it.copy(counter = it.counter + 1, updatedAt = now) else it
        }
        persistAndSync()
    }

    suspend fun togglePin(id: String) = withContext(Dispatchers.IO) {
        val now = IsoTime.now()
        accounts = accounts.map { if (it.id == id) it.copy(pinned = !it.pinned, updatedAt = now) else it }
        accounts = VaultJson.manualSort(accounts)
        persistAndSync()
    }

    suspend fun reorder(orderedIds: List<String>) = withContext(Dispatchers.IO) {
        val position = orderedIds.withIndex().associate { it.value to it.index }
        val now = IsoTime.now()
        accounts = accounts.map { account ->
            val order = position[account.id] ?: return@map account
            if (order == account.order) account else account.copy(order = order, updatedAt = now)
        }
        accounts = VaultJson.manualSort(accounts)
        persistAndSync()
    }

    // ---------------------------------------------------------------- 同期

    suspend fun attachSync(syncToken: String): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val vaultId = SyncCode.deriveVaultId(syncToken)
            val remote = api.get(vaultId, syncToken)
            val vault = activeStoredVault() ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
            updateStoredVault(
                vault.copy(
                    envelope = remote.envelope,
                    token = syncToken,
                    syncedRevision = remote.revision,
                ),
            )
            envelope = remote.envelope
            token = syncToken
            syncedRevision = remote.revision
            dek?.fill(0)
            dek = null
            accounts = emptyList()
            tombstones = emptyList()
            devices = emptyList()
            _state.value = _state.value.copy(
                unlocked = false,
                accounts = emptyList(),
                devices = emptyList(),
                syncEnabled = true,
                syncCode = syncToken,
                syncedRevision = remote.revision,
                syncState = SyncState.SYNCED,
                lastSyncedAt = remote.envelope.updatedAt,
                conflict = null,
                syncError = null,
            )
            Result.success(Unit)
        } catch (_: SyncNotFoundException) {
            Result.failure(IllegalStateException("同期コードのボルトが見つかりません"))
        } catch (error: Exception) {
            Result.failure(IllegalStateException("同期コードで接続できませんでした（通信を確認してください）"))
        }
    }

    fun syncCode(): String? = token

    /** ローカル完結のボルトに同期コードを発行して、サーバーへ初回送信する。 */
    suspend fun enableSync(): Result<String> = withContext(Dispatchers.IO) {
        val current = activeStoredVault() ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
        if (token != null) return@withContext Result.success(token!!)
        val newToken = SyncCode.generateToken()
        token = newToken
        syncedRevision = 0
        updateStoredVault(current.copy(token = newToken, syncedRevision = 0))
        _state.value = _state.value.copy(
            syncEnabled = true,
            syncCode = newToken,
            syncedRevision = 0,
            syncState = SyncState.PENDING,
        )
        if (_state.value.unlocked) persistAndSync()
        scheduleSync()
        Result.success(newToken)
    }

    suspend fun disableSync() = withContext(Dispatchers.IO) {
        val vaultId = token?.let { SyncCode.deriveVaultId(it) }
        val currentToken = token
        if (vaultId != null && currentToken != null) {
            runCatching { api.remove(vaultId, currentToken) }
        }
        token = null
        syncedRevision = null
        activeStoredVault()?.let { updateStoredVault(it.copy(token = null, syncedRevision = null)) }
        _state.value = _state.value.copy(
            syncEnabled = false,
            syncCode = null,
            syncedRevision = null,
            syncState = SyncState.LOCAL_ONLY,
            conflict = null,
            syncError = null,
        )
    }

    fun scheduleSync() {
        syncTimer?.cancel()
        syncTimer = scope.launch {
            delay(2_000)
            syncNowInternal()
        }
    }

    suspend fun syncNow(): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            syncNowInternal()
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    /**
     * 1 回の同期。判断は [SyncEngine] に任せ、ここでは保存と画面の状態だけを扱う。
     *
     * 未送信の変更が無い（`envelope.revision <= syncedRevision`）ときに `PUT` を送ると
     * サーバーが `400 revision_must_advance` を返すため、[SyncEngine] はその場合は `GET` する。
     */
    private suspend fun syncNowInternal(): Unit = writeMutex.withLock {
        val currentToken = token ?: return@withLock
        val sent = envelope ?: return@withLock
        val base = syncedRevision ?: 0
        _state.value = _state.value.copy(
            syncState = SyncState.PENDING,
            syncError = null,
            syncErrorCode = null,
        )
        val outcome = try {
            syncEngine.sync(
                SyncRequest(
                    token = currentToken,
                    envelope = sent,
                    baseRevision = base,
                    local = localDataOrNull(),
                    dek = dek,
                ),
            )
        } catch (error: Exception) {
            SyncOutcome.Failed(SyncFailure.of(error))
        }
        when (outcome) {
            is SyncOutcome.Synced -> applySynced(outcome.applied)
            is SyncOutcome.Conflict -> _state.value = _state.value.copy(
                syncState = SyncState.CONFLICT,
                conflict = ConflictState(outcome.remoteRevision, outcome.remoteEnvelope),
                syncError = null,
                syncErrorCode = null,
            )
            is SyncOutcome.Failed -> _state.value = _state.value.copy(
                syncState = SyncState.ERROR,
                syncError = outcome.failure.message,
                syncErrorCode = outcome.failure.debugLabel,
            )
        }
    }

    /** ロック中は中身を渡さない（比較できないので封筒だけ同期する）。 */
    private fun localDataOrNull(): VaultData? {
        if (dek == null || !_state.value.unlocked) return null
        return VaultData(
            accounts = accounts,
            tombstones = tombstones,
            devices = if (devices.isEmpty()) null else devices,
            passkeyInfos = if (passkeyInfos.isEmpty()) null else passkeyInfos,
        )
    }

    private suspend fun applySynced(applied: SyncApplied) {
        envelope = applied.envelope
        syncedRevision = applied.revision
        activeStoredVault()?.let {
            updateStoredVault(it.copy(envelope = applied.envelope, syncedRevision = applied.revision))
        }
        val data = applied.data
        if (data != null && dek != null) {
            accounts = VaultJson.manualSort(data.accounts)
            tombstones = data.tombstones.orEmpty()
            devices = data.devices.orEmpty()
            passkeyInfos = data.passkeyInfos.orEmpty()
        }
        _state.value = _state.value.copy(
            accounts = accounts,
            devices = devices,
            syncedRevision = applied.revision,
            syncState = if (applied.pendingPush) SyncState.PENDING else SyncState.SYNCED,
            syncError = null,
            syncErrorCode = null,
            lastSyncedAt = applied.updatedAt.ifBlank { _state.value.lastSyncedAt },
            conflict = null,
        )
        val pull = applied.pull
        if (pull != null && !applied.pendingPush && (pull.added > 0 || pull.updated > 0)) {
            emit(
                "他の端末の変更を取り込みました（追加 ${pull.added} / 更新 ${pull.updated}）",
            )
        }
    }

    suspend fun resolveConflict(mode: String): Result<Pair<Int, Int>> = withContext(Dispatchers.IO) {
        val conflict = _state.value.conflict
            ?: return@withContext Result.failure(IllegalStateException("競合がありません"))
        val currentEnvelope = envelope ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
        val currentToken = token ?: return@withContext Result.failure(IllegalStateException("同期していません"))

        if (mode == "discard") {
            envelope = conflict.remoteEnvelope
            syncedRevision = conflict.remoteRevision
            activeStoredVault()?.let {
                updateStoredVault(it.copy(envelope = conflict.remoteEnvelope, syncedRevision = conflict.remoteRevision))
            }
            val currentDek = dek
            if (currentDek != null) {
                try {
                    applyLoadedData(VaultJson.parse(Crypto.decryptWithDek(conflict.remoteEnvelope, currentDek)))
                } catch (_: Exception) {
                    dek?.fill(0)
                    dek = null
                    accounts = emptyList()
                }
            }
            _state.value = _state.value.copy(
                conflict = null,
                syncedRevision = conflict.remoteRevision,
                syncState = SyncState.SYNCED,
                unlocked = dek != null,
            )
            return@withContext Result.success(0 to 0)
        }

        val currentDek = dek ?: return@withContext Result.failure(IllegalStateException("ロックされています"))
        var mergedAccounts = accounts
        var mergedTombstones = tombstones
        var mergedDevices = devices
        var mergedPasskeyInfos = passkeyInfos
        var added = 0
        var updated = 0
        if (mode == "merge") {
            val remoteData = VaultJson.parse(Crypto.decryptWithDek(conflict.remoteEnvelope, currentDek))
            val result = VaultMerge.merge(
                VaultData(accounts, mergedTombstones, mergedDevices, passkeyInfos.ifEmpty { null }),
                remoteData,
            )
            mergedAccounts = result.data.accounts
            mergedTombstones = result.data.tombstones.orEmpty()
            mergedDevices = result.data.devices.orEmpty()
            mergedPasskeyInfos = result.data.passkeyInfos.orEmpty()
            added = result.added
            updated = result.updated
        }

        val revision = conflict.remoteRevision + 1
        val data = VaultData(
            accounts = VaultJson.manualSort(mergedAccounts),
            tombstones = mergedTombstones,
            devices = if (mergedDevices.isEmpty()) null else mergedDevices,
            passkeyInfos = if (mergedPasskeyInfos.isEmpty()) null else mergedPasskeyInfos,
        )
        val next = Crypto.updateEnvelopeData(currentEnvelope, currentDek, VaultJson.serialize(data), revision)
        envelope = next
        accounts = data.accounts
        tombstones = mergedTombstones
        devices = mergedDevices
        passkeyInfos = mergedPasskeyInfos
        syncedRevision = conflict.remoteRevision
        activeStoredVault()?.let {
            updateStoredVault(it.copy(envelope = next, syncedRevision = conflict.remoteRevision))
        }
        _state.value = _state.value.copy(
            accounts = accounts,
            devices = devices,
            conflict = null,
            syncedRevision = conflict.remoteRevision,
            syncState = SyncState.PENDING,
        )
        scheduleSync()
        Result.success(added to updated)
    }

    // ------------------------------------------------------------- サイト連携

    /** サイト版の「アプリでログイン」を受け取る。復号できたときだけ保存する。 */
    suspend fun handleAppLogin(payload: AppLoginPayload): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val vaultId = SyncCode.deriveVaultId(payload.token)
            val remote = api.get(vaultId, payload.token)
            val plaintext = Crypto.decryptWithDek(remote.envelope, payload.dek)
            val data = VaultJson.parse(plaintext)

            val existingId = stored?.vaults?.firstOrNull { it.token == payload.token }?.id
            val vaultIdLocal = existingId ?: UUID.randomUUID().toString()
            val now = IsoTime.now()
            val vault = StoredVault(
                id = vaultIdLocal,
                name = payload.vaultName,
                createdAt = stored?.vaults?.firstOrNull { it.id == vaultIdLocal }?.createdAt ?: now,
                envelope = remote.envelope,
                token = payload.token,
                syncedRevision = remote.revision,
                biometricWrap = stored?.vaults?.firstOrNull { it.id == vaultIdLocal }?.biometricWrap,
            )
            val existingVaults = stored?.vaults.orEmpty().filterNot { it.id == vaultIdLocal }
            stored = StoredState(
                version = 1,
                activeVaultId = vaultIdLocal,
                vaults = existingVaults + vault,
            )
            persistStored()
            envelope = remote.envelope
            token = payload.token
            syncedRevision = remote.revision
            dek = payload.dek.copyOf()
            accounts = VaultJson.manualSort(data.accounts)
            tombstones = data.tombstones.orEmpty()
            devices = data.devices.orEmpty()
            passkeyInfos = data.passkeyInfos.orEmpty()
            touch()
            _state.value = _state.value.copy(
                hasVault = true,
                unlocked = true,
                vaultName = payload.vaultName,
                accounts = accounts,
                devices = devices,
                profiles = stored?.vaults?.map { VaultProfile(it.id, it.name, it.createdAt) }.orEmpty(),
                activeProfileId = vaultIdLocal,
                syncEnabled = true,
                syncCode = payload.token,
                syncedRevision = remote.revision,
                syncState = SyncState.SYNCED,
                lastSyncedAt = remote.envelope.updatedAt,
                conflict = null,
                syncError = null,
                event = RepoEvent.AppLoginDone(payload.vaultName),
            )
            Result.success(Unit)
        } catch (_: SyncNotFoundException) {
            _state.value = _state.value.copy(
                event = RepoEvent.AppLoginFailed("サイトのボルトがまだ同期されていません。サイト側でもう一度押してください"),
            )
            Result.failure(IllegalStateException("同期が見つかりません"))
        } catch (error: Exception) {
            _state.value = _state.value.copy(
                event = RepoEvent.AppLoginFailed("受け渡しを復号できませんでした"),
            )
            Result.failure(error)
        }
    }

    // ------------------------------------------------- パスワード・プロファイル

    suspend fun changePassword(newPassword: String): Result<Unit> = withContext(Dispatchers.IO) {
        val current = envelope ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
        val currentDek = dek ?: return@withContext Result.failure(IllegalStateException("ロックされています"))
        if (newPassword.length < Crypto.MIN_PASSWORD_LENGTH) {
            return@withContext Result.failure(IllegalStateException("パスワードは${Crypto.MIN_PASSWORD_LENGTH}文字以上にしてください"))
        }
        val rewrapped = Crypto.rewrapEnvelope(current, currentDek, newPassword)
        envelope = rewrapped
        activeStoredVault()?.let { updateStoredVault(it.copy(envelope = rewrapped)) }
        persistAndSync()
        Result.success(Unit)
    }

    suspend fun createProfile(name: String, password: String): Result<Unit> = withContext(Dispatchers.IO) {
        if (password.length < Crypto.MIN_PASSWORD_LENGTH) {
            return@withContext Result.failure(IllegalStateException("パスワードは${Crypto.MIN_PASSWORD_LENGTH}文字以上にしてください"))
        }
        val id = UUID.randomUUID().toString()
        val now = IsoTime.now()
        val label = name.trim().ifEmpty { "ボルト" }
        val newDek = Crypto.generateDek()
        val data = VaultData(emptyList(), emptyList(), null)
        val newEnvelope = Crypto.createEnvelope(password, VaultJson.serialize(data), 1, dek = newDek)
        val vault = StoredVault(id = id, name = label, createdAt = now, envelope = newEnvelope, token = null, syncedRevision = null)
        stored = (stored ?: StoredState()).let { current ->
            current.copy(vaults = current.vaults + vault)
        }
        persistStored()
        switchToProfileInternal(id)
        Result.success(Unit)
    }

    suspend fun switchProfile(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        if (id == _state.value.activeProfileId) return@withContext Result.success(Unit)
        syncTimer?.cancel()
        runCatching { syncNowInternal() }
        switchToProfileInternal(id)
        Result.success(Unit)
    }

    private suspend fun switchToProfileInternal(id: String) {
        val state = stored ?: return
        val vault = state.vaults.firstOrNull { it.id == id } ?: return
        stored = state.copy(activeVaultId = id)
        persistStored()
        dek?.fill(0)
        dek = null
        accounts = emptyList()
        tombstones = emptyList()
        devices = emptyList()
        envelope = vault.envelope
        token = vault.token
        syncedRevision = vault.syncedRevision
        val settings = settingsStore.load()
        _state.value = _state.value.copy(
            unlocked = false,
            hasVault = vault.envelope != null,
            vaultName = vault.name,
            accounts = emptyList(),
            devices = emptyList(),
            activeProfileId = id,
            profiles = stored?.vaults?.map { VaultProfile(it.id, it.name, it.createdAt) }.orEmpty(),
            syncEnabled = vault.token != null,
            syncCode = vault.token,
            syncedRevision = vault.syncedRevision,
            syncState = when {
                vault.token == null -> SyncState.LOCAL_ONLY
                vault.syncedRevision != null -> SyncState.SYNCED
                else -> SyncState.PENDING
            },
            conflict = null,
            syncError = null,
            biometricEnabled = settings.biometricEnabled && vault.biometricWrap != null,
        )
    }

    suspend fun renameProfile(id: String, name: String) = withContext(Dispatchers.IO) {
        val label = name.trim().ifEmpty { "ボルト" }
        stored = stored?.let { state ->
            state.copy(vaults = state.vaults.map { if (it.id == id) it.copy(name = label) else it })
        }
        persistStored()
        _state.value = _state.value.copy(
            vaultName = if (_state.value.activeProfileId == id) label else _state.value.vaultName,
            profiles = stored?.vaults?.map { VaultProfile(it.id, it.name, it.createdAt) }.orEmpty(),
        )
    }

    suspend fun deleteProfile(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        val state = stored ?: return@withContext Result.failure(IllegalStateException("ボルトがありません"))
        if (state.vaults.size <= 1) {
            return@withContext Result.failure(IllegalStateException("最後のボルトは削除できません"))
        }
        val remaining = state.vaults.filterNot { it.id == id }
        val nextActive = if (state.activeVaultId == id) remaining.first().id else state.activeVaultId
        stored = state.copy(vaults = remaining, activeVaultId = nextActive)
        persistStored()
        if (state.activeVaultId == id) switchToProfileInternal(nextActive)
        _state.value = _state.value.copy(
            profiles = stored?.vaults?.map { VaultProfile(it.id, it.name, it.createdAt) }.orEmpty(),
        )
        Result.success(Unit)
    }

    // ------------------------------------------------------------------ 端末

    suspend fun renameDevice(name: String) = withContext(Dispatchers.IO) {
        val label = name.trim().ifEmpty { "Android" }
        val settings = settingsStore.load().copy(deviceName = label)
        settingsStore.save(settings)
        devices = devices.map { if (it.id == settings.deviceId) it.copy(name = label) else it }
        _state.value = _state.value.copy(settings = settings, devices = devices)
        if (_state.value.unlocked) persistAndSync()
    }

    suspend fun forgetDevice(id: String) = withContext(Dispatchers.IO) {
        devices = devices.filterNot { it.id == id }
        _state.value = _state.value.copy(devices = devices)
        if (_state.value.unlocked) persistAndSync()
    }

    fun setSettings(settings: AegisSettings) {
        settingsStore.save(settings)
        _state.value = _state.value.copy(settings = settings)
    }

    fun consumeEvent() {
        _state.value = _state.value.copy(event = null)
    }

    fun emit(message: String, isError: Boolean = false) {
        _state.value = _state.value.copy(event = RepoEvent.Message(message, isError))
    }

    // --------------------------------------------------------------- 内部処理

    private fun isUnlocked(): Boolean = dek != null && _state.value.unlocked

    private fun activeStoredVault(): StoredVault? {
        val state = stored ?: return null
        return state.vaults.firstOrNull { it.id == state.activeVaultId }
    }

    private fun updateStoredVault(vault: StoredVault) {
        val state = stored ?: return
        stored = state.copy(vaults = state.vaults.map { if (it.id == vault.id) vault else it })
        persistStored()
    }

    private fun persistStored() {
        stored?.let { store.save(it) }
    }

    /** データを暗号化して保存し、同期を予約する。 */
    private suspend fun persistAndSync() {
        val currentDek = dek ?: return
        val currentEnvelope = envelope ?: return
        val settings = _state.value.settings
        val now = IsoTime.now()
        val device = com.yuushilabs.aegis.core.SyncDevice(
            id = settings.deviceId,
            name = settings.deviceName,
            platform = "Android",
            lastSyncedAt = now,
        )
        devices = VaultMerge.mergeDevices(devices, listOf(device))
        val data = VaultData(
            accounts = VaultJson.manualSort(accounts),
            tombstones = tombstones,
            devices = if (devices.isEmpty()) null else devices,
            passkeyInfos = if (passkeyInfos.isEmpty()) null else passkeyInfos,
        )
        val next = Crypto.updateEnvelopeData(
            envelope = currentEnvelope,
            dek = currentDek,
            plaintext = VaultJson.serialize(data),
            revision = currentEnvelope.revision + 1,
            updatedAt = now,
        )
        envelope = next
        accounts = data.accounts
        passkeyInfos = data.passkeyInfos.orEmpty()
        activeStoredVault()?.let { updateStoredVault(it.copy(envelope = next)) }
        _state.value = _state.value.copy(accounts = accounts, devices = devices)
        scheduleSync()
    }
}
