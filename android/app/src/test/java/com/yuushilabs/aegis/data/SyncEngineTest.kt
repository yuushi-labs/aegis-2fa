package com.yuushilabs.aegis.data

import com.yuushilabs.aegis.core.Account
import com.yuushilabs.aegis.core.Crypto
import com.yuushilabs.aegis.core.Tombstone
import com.yuushilabs.aegis.core.VaultData
import com.yuushilabs.aegis.core.VaultEnvelope
import com.yuushilabs.aegis.core.VaultJson
import com.yuushilabs.aegis.core.VaultMerge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * 同期の判断（`http_400` の原因だった「未変更なのに PUT」を含む）を、偽の通信で確かめる。
 * 実際の暗号処理（AES-GCM）を使うので、マージ結果が復号できることも同時に見ている。
 */
class SyncEngineTest {

    private val password = "correct horse battery staple"
    private val dek = ByteArray(32) { index -> (index + 7).toByte() }
    private val token = "0123456789abcdefghijklmnopqrstuvwxyzABCD"
    private val vaultId = com.yuushilabs.aegis.core.SyncCode.deriveVaultId(token)

    private fun account(id: String, label: String, updatedAt: String) = Account(
        id = id,
        issuer = "Service",
        label = label,
        secret = "JBSWY3DPEHPK3PXP",
        createdAt = "2026-11-20T00:00:00.000Z",
        updatedAt = updatedAt,
    )

    private fun envelope(revision: Int, accounts: List<Account>, tombstones: List<Tombstone> = emptyList()): VaultEnvelope =
        Crypto.createEnvelope(
            password = password,
            plaintext = VaultJson.serialize(VaultData(accounts, tombstones)),
            revision = revision,
            iterations = Crypto.MIN_KDF_ITERATIONS,
            updatedAt = "2026-11-21T0$revision:00:00.000Z",
            dek = dek,
        )

    private fun data(vararg accounts: Account) = VaultData(accounts.toList(), emptyList())

    private class FakeTransport(var remote: RemoteVaultSnapshot?) : SyncTransport {
        val getCalls = mutableListOf<String>()
        val putCalls = mutableListOf<Pair<VaultEnvelope, Int>>()

        /** 何回目の PUT で何を投げるか（1 から）。 */
        var putFailures: List<Exception?> = emptyList()

        override fun get(vaultId: String, token: String): RemoteVaultSnapshot {
            getCalls += vaultId
            return remote ?: throw SyncNotFoundException()
        }

        override fun put(vaultId: String, token: String, envelope: VaultEnvelope, baseRevision: Int): Int {
            putCalls += envelope to baseRevision
            putFailures.getOrNull(putCalls.size - 1)?.let { throw it }
            remote = RemoteVaultSnapshot(envelope, envelope.revision)
            return envelope.revision
        }
    }

    @Test
    fun `no local change fetches instead of pushing (the http_400 bug)`() {
        val local = envelope(3, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(local, 3))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(
            SyncRequest(token, local, baseRevision = 3, local = data(account("a", "one", "2026-11-21T00:00:00.000Z")), dek = dek),
        )

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(1, transport.getCalls.size)
        assertTrue("未変更のときは PUT を送らない", transport.putCalls.isEmpty())
        assertEquals(3, (outcome as SyncOutcome.Synced).applied.revision)
    }

    @Test
    fun `local change is pushed with the synced revision as base`() {
        val local = envelope(4, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val server = envelope(3, listOf(account("a", "one", "2026-11-20T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 3))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(
            SyncRequest(token, local, baseRevision = 3, local = data(account("a", "one", "2026-11-21T00:00:00.000Z")), dek = dek),
        )

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(1, transport.putCalls.size)
        assertEquals(3, transport.putCalls.single().second)
        assertEquals(4, transport.putCalls.single().first.revision)
        assertTrue("PUT の revision は base より進んでいる", transport.putCalls.single().first.revision > 3)
    }

    @Test
    fun `server newer than base is pulled and adopted`() {
        val server = envelope(5, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        val engine = SyncEngine(transport)
        val local = envelope(3, emptyList())

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        val applied = (outcome as SyncOutcome.Synced).applied
        assertEquals(5, applied.revision)
        assertEquals("サーバーのアカウントを取り込む", "one", applied.data?.accounts?.single()?.label)
        assertEquals(1, transport.getCalls.size)
        assertTrue("内容が同じなら送り返さない", transport.putCalls.isEmpty())
    }

    @Test
    fun `server newer while locked adopts the envelope without decrypting`() {
        val server = envelope(5, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        val engine = SyncEngine(transport)
        val local = envelope(3, emptyList())

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = null, dek = null))

        assertTrue(outcome is SyncOutcome.Synced)
        val applied = (outcome as SyncOutcome.Synced).applied
        assertEquals(5, applied.revision)
        assertEquals(server, applied.envelope)
        assertNull(applied.data)
        assertTrue(transport.putCalls.isEmpty())
    }

    @Test
    fun `merge pushes a new revision when the server holds other accounts`() {
        val localAccount = account("local", "手元", "2026-11-21T10:00:00.000Z")
        val remoteAccount = account("remote", "サーバー", "2026-11-21T09:00:00.000Z")
        val local = envelope(3, listOf(localAccount))
        val server = envelope(5, listOf(remoteAccount))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        val engine = SyncEngine(transport)

        // 未送信の変更は無い（3 == base）が、サーバーが先に進んでいる。
        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = data(localAccount), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        val applied = (outcome as SyncOutcome.Synced).applied
        val pushed = transport.putCalls.last()
        assertEquals(5, pushed.second)
        assertEquals(6, pushed.first.revision)
        assertEquals(2, applied.data?.accounts?.size)
        assertEquals(1, applied.pull?.added)
    }

    @Test
    fun `missing on the server uploads from scratch with base 0`() {
        val local = envelope(2, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(null)
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 2, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(1, transport.putCalls.size)
        assertEquals(0, transport.putCalls.single().second)
    }

    @Test
    fun `revision zero envelope is bumped before the upload`() {
        val zero = envelope(0, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(null)
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, zero, baseRevision = 0, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(1, transport.putCalls.single().first.revision)
        assertEquals(0, transport.putCalls.single().second)
        // 上げた revision はデータの AAD と揃っているので、その封筒は開ける。
        val pushed = transport.putCalls.single().first
        assertNotNull(VaultJson.parse(Crypto.decryptWithDek(pushed, dek)))
    }

    @Test
    fun `locked revision zero envelope fails without sending`() {
        val zero = envelope(0, emptyList())
        val transport = FakeTransport(null)
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, zero, baseRevision = 0, local = null, dek = null))

        assertTrue(outcome is SyncOutcome.Failed)
        assertEquals("stale_envelope", (outcome as SyncOutcome.Failed).failure.code)
        assertTrue(transport.putCalls.isEmpty())
    }

    @Test
    fun `conflict is reported when the server holds another envelope`() {
        val local = envelope(4, listOf(account("a", "mine", "2026-11-21T00:00:00.000Z")))
        val server = envelope(6, listOf(account("b", "theirs", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 6))
        transport.putFailures = listOf(SyncConflictException(6))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Conflict)
        assertEquals(6, (outcome as SyncOutcome.Conflict).remoteRevision)
    }

    @Test
    fun `revision_must_advance is recovered by pulling, not by repeating the put`() {
        val local = envelope(4, listOf(account("a", "one", "2026-11-21T00:00:00.000Z")))
        val server = envelope(5, listOf(account("b", "two", "2026-11-21T00:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        transport.putFailures = listOf(SyncHttpException(400, "revision_must_advance"))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(1, transport.getCalls.size)
        val applied = (outcome as SyncOutcome.Synced).applied
        assertTrue((applied.data?.accounts?.size ?: 0) >= 1)
        assertEquals(5, applied.revision)
    }

    @Test
    fun `network failure becomes a friendly message with a debug label`() {
        val local = envelope(4, emptyList())
        val transport = FakeTransport(RemoteVaultSnapshot(local, 3))
        transport.putFailures = listOf(java.io.IOException("timeout"))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = data(), dek = dek))

        assertTrue(outcome is SyncOutcome.Failed)
        val failure = (outcome as SyncOutcome.Failed).failure
        assertEquals("network", failure.code)
        assertFalse("生のコードを画面に出さない", failure.message.contains("network"))
        assertTrue(failure.message.contains("接続できませんでした"))
        assertTrue(failure.debugLabel.contains("network"))
    }

    @Test
    fun `http errors map to japanese messages and keep the server code for debugging`() {
        val body = SyncFailure.fromStatus(400, "revision_must_advance")
        assertTrue(body.message.contains("もう一度同期"))
        assertEquals("http_400 revision_must_advance", body.debugLabel)
        assertFalse(body.message.contains("http_"))

        val unauthorized = SyncFailure.fromStatus(401, "not_found")
        assertTrue(unauthorized.message.contains("同期コード"))

        val server = SyncFailure.fromStatus(503)
        assertTrue(server.message.contains("サーバー側"))
        assertEquals("http_503", server.debugLabel)

        val rateLimited = SyncFailure.fromStatus(429)
        assertTrue(rateLimited.message.contains("少し待って"))
    }

    @Test
    fun `merge of identical data does not push`() {
        val shared = listOf(account("a", "one", "2026-11-21T00:00:00.000Z"))
        val local = envelope(3, shared)
        val server = envelope(5, shared)
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(SyncRequest(token, local, baseRevision = 3, local = VaultData(shared, emptyList()), dek = dek))

        assertTrue(outcome is SyncOutcome.Synced)
        assertEquals(5, (outcome as SyncOutcome.Synced).applied.revision)
        assertTrue(transport.putCalls.isEmpty())
        assertEquals(VaultMerge.merge(VaultData(shared, emptyList()), VaultData(shared, emptyList())).data.accounts.size, 1)
    }

    @Test
    fun `merge keeps local deletion through tombstones`() {
        val localAccounts = listOf(account("a", "one", "2026-11-21T00:00:00.000Z"))
        val localTombstone = listOf(Tombstone("a", "2026-11-21T05:00:00.000Z"))
        val local = envelope(4, localAccounts, localTombstone)
        val server = envelope(5, localAccounts)
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(
            SyncRequest(
                token,
                local,
                baseRevision = 4,
                local = VaultData(localAccounts, localTombstone),
                dek = dek,
            ),
        )

        assertTrue(outcome is SyncOutcome.Synced)
        val applied = (outcome as SyncOutcome.Synced).applied
        assertTrue("削除がサーバーへ送られる", transport.putCalls.isNotEmpty())
        assertFalse(applied.data?.accounts.orEmpty().any { it.id == "a" })
    }

    @Test
    fun `vault id is derived from the token`() {
        val transport = FakeTransport(null)
        SyncEngine(transport).sync(SyncRequest(token, envelope(1, emptyList()), 1, data(), dek))
        assertEquals(vaultId, transport.getCalls.single())
    }

    @Test
    fun `pending push keeps the merged envelope for the next sync`() {
        val local = envelope(4, listOf(account("local", "hand", "2026-11-21T10:00:00.000Z")))
        val server = envelope(5, listOf(account("remote", "server", "2026-11-21T09:00:00.000Z")))
        val transport = FakeTransport(RemoteVaultSnapshot(server, 5))
        transport.putFailures = listOf(java.io.IOException("offline"))
        val engine = SyncEngine(transport)

        val outcome = engine.sync(
            SyncRequest(token, local, baseRevision = 4, local = data(account("local", "hand", "2026-11-21T10:00:00.000Z")), dek = dek),
        )

        assertTrue(outcome is SyncOutcome.Synced)
        val applied = (outcome as SyncOutcome.Synced).applied
        assertTrue("送れなくてもマージ結果は残す", applied.pendingPush)
        assertEquals(6, applied.envelope.revision)
        assertEquals(5, applied.revision)
        assertEquals(2, applied.data?.accounts?.size)
    }

    @Test
    fun `account counter increments are only pushed when the envelope advanced`() {
        val counter = AtomicInteger(0)
        val transport = object : SyncTransport {
            override fun get(vaultId: String, token: String): RemoteVaultSnapshot {
                counter.incrementAndGet()
                return RemoteVaultSnapshot(envelope(2, emptyList()), 2)
            }

            override fun put(vaultId: String, token: String, envelope: VaultEnvelope, baseRevision: Int): Int {
                counter.addAndGet(10)
                return envelope.revision
            }
        }
        SyncEngine(transport).sync(SyncRequest(token, envelope(2, emptyList()), 2, data(), dek))
        assertEquals(1, counter.get())
    }
}
