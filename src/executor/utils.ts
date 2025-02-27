import {
    EntryPointV06Abi,
    EntryPointV07Abi,
    PackedUserOperation,
    UserOpInfo,
    UserOperationV07
} from "@alto/types"
import {
    isVersion06,
    toPackedUserOperation,
    type Logger,
    isVersion07
} from "@alto/utils"
// biome-ignore lint/style/noNamespaceImport: explicitly make it clear when sentry is used
import * as sentry from "@sentry/node"
import {
    type Account,
    type Chain,
    type PublicClient,
    type Transport,
    type WalletClient,
    BaseError,
    encodeFunctionData,
    Address,
    Hex
} from "viem"
import { SignedAuthorizationList } from "viem/experimental"

export const isTransactionUnderpricedError = (e: BaseError) => {
    return e?.details
        ?.toLowerCase()
        .includes("replacement transaction underpriced")
}

// V7 source: https://github.com/eth-infinitism/account-abstraction/blob/releases/v0.7/contracts/core/EntryPoint.sol
// V6 source: https://github.com/eth-infinitism/account-abstraction/blob/fa61290d37d079e928d92d53a122efcc63822214/contracts/core/EntryPoint.sol#L236
export function calculateAA95GasFloor(userOps: UserOpInfo[]): bigint {
    let gasFloor = 0n

    for (const userOpInfo of userOps) {
        const { userOp } = userOpInfo
        if (isVersion07(userOp)) {
            const totalGas =
                userOp.callGasLimit +
                (userOp.paymasterPostOpGasLimit || 0n) +
                10_000n
            gasFloor += (totalGas * 64n) / 63n
        } else {
            gasFloor +=
                userOp.callGasLimit + userOp.verificationGasLimit + 5000n
        }
    }

    return gasFloor
}

export const getUserOpHashes = (userOpInfos: UserOpInfo[]) => {
    return userOpInfos.map(({ userOpHash }) => userOpHash)
}

export const packUserOps = (userOpInfos: UserOpInfo[]) => {
    const userOps = userOpInfos.map(({ userOp }) => userOp)
    const isV06 = isVersion06(userOps[0])
    const packedUserOps = isV06
        ? userOps
        : userOps.map((op) => toPackedUserOperation(op as UserOperationV07))
    return packedUserOps as PackedUserOperation[]
}

export const encodeHandleOpsCalldata = ({
    userOps,
    beneficiary
}: {
    userOps: UserOpInfo[]
    beneficiary: Address
}): Hex => {
    const ops = userOps.map(({ userOp }) => userOp)
    const isV06 = isVersion06(ops[0])
    const packedUserOps = packUserOps(userOps)

    return encodeFunctionData({
        abi: isV06 ? EntryPointV06Abi : EntryPointV07Abi,
        functionName: "handleOps",
        args: [packedUserOps, beneficiary]
    })
}

export const getAuthorizationList = (
    userOpInfos: UserOpInfo[]
): SignedAuthorizationList | undefined => {
    const authList = userOpInfos
        .map(({ userOp }) => userOp)
        .map(({ eip7702auth }) => eip7702auth)
        .filter(Boolean) as SignedAuthorizationList

    return authList.length ? authList : undefined
}

export async function flushStuckTransaction(
    publicClient: PublicClient,
    walletClient: WalletClient<Transport, Chain, Account | undefined>,
    wallet: Account,
    gasPrice: bigint,
    logger: Logger
) {
    const latestNonce = await publicClient.getTransactionCount({
        address: wallet.address,
        blockTag: "latest"
    })
    const pendingNonce = await publicClient.getTransactionCount({
        address: wallet.address,
        blockTag: "pending"
    })

    logger.debug(
        { latestNonce, pendingNonce, wallet: wallet.address },
        "checking for stuck transactions"
    )

    // same nonce is okay
    if (latestNonce === pendingNonce) {
        return
    }

    // one nonce ahead is also okay
    if (latestNonce + 1 === pendingNonce) {
        return
    }

    logger.info(
        { latestNonce, pendingNonce, wallet: wallet.address },
        "found stuck transaction, flushing"
    )

    for (
        let nonceToFlush = latestNonce;
        nonceToFlush < pendingNonce;
        nonceToFlush++
    ) {
        try {
            const txHash = await walletClient.sendTransaction({
                account: wallet,
                to: wallet.address,
                value: 0n,
                nonce: nonceToFlush,
                maxFeePerGas: gasPrice,
                maxPriorityFeePerGas: gasPrice
            })

            logger.debug(
                { txHash, nonce: nonceToFlush, wallet: wallet.address },
                "flushed stuck transaction"
            )
        } catch (e) {
            sentry.captureException(e)
            logger.warn({ error: e }, "error flushing stuck transaction")
        }
    }
}
