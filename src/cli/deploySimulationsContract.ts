import {
    DETERMINISTIC_DEPLOYER_TRANSACTION,
    pimlicoEntrypointSimulationsV7DeployBytecode,
    pimlicoEntrypointSimulationsSalt,
    pimlicoEntrypointSimulationsV8DeployBytecode
} from "@alto/types"
import {
    type Chain,
    createWalletClient,
    getContractAddress,
    type Hex,
    http,
    type PublicClient,
    type Transport,
    concat
} from "viem"
import type { CamelCasedProperties } from "./parseArgs"
import type { IOptions } from "@alto/cli"

const isContractDeployed = async ({
    publicClient,
    address
}: { publicClient: PublicClient<Transport, Chain>; address: Hex }) => {
    const code = await publicClient.getCode({
        address
    })
    return code !== undefined && code !== "0x"
}

export const deploySimulationsContract = async ({
    args,
    publicClient
}: {
    args: CamelCasedProperties<IOptions>
    publicClient: PublicClient<Transport, Chain>
}): Promise<{
    entrypointSimulationContractV7: Hex
    entrypointSimulationContractV8: Hex
}> => {
    const utilityPrivateKey = args.utilityPrivateKey
    if (!utilityPrivateKey) {
        throw new Error(
            "Cannot deploy entryPoint simulations without utility-private-key"
        )
    }

    // if (args.entrypointSimulationContract) {
    //     if (
    //         await isContractDeployed({
    //             publicClient,
    //             address: args.entrypointSimulationContract
    //         })
    //     ) {
    //         return args.entrypointSimulationContract
    //     }
    // }

    const walletClient = createWalletClient({
        transport: http(args.rpcUrl),
        account: utilityPrivateKey
    })

    if (
        !(await isContractDeployed({
            publicClient,
            address: args.deterministicDeployerAddress
        }))
    ) {
        const deterministicDeployHash = await walletClient.sendRawTransaction({
            serializedTransaction: DETERMINISTIC_DEPLOYER_TRANSACTION
        })

        await publicClient.waitForTransactionReceipt({
            hash: deterministicDeployHash
        })
    }

    const contractAddressV7 = getContractAddress({
        opcode: "CREATE2",
        bytecode: pimlicoEntrypointSimulationsV7DeployBytecode,
        salt: pimlicoEntrypointSimulationsSalt,
        from: args.deterministicDeployerAddress
    })

    const contractAddressV8 = getContractAddress({
        opcode: "CREATE2",
        bytecode: pimlicoEntrypointSimulationsV8DeployBytecode,
        salt: pimlicoEntrypointSimulationsSalt,
        from: args.deterministicDeployerAddress
    })

    const [isV7Deployed, isV8Deployed] = await Promise.all([
        isContractDeployed({ publicClient, address: contractAddressV7 }),
        isContractDeployed({ publicClient, address: contractAddressV8 })
    ])

    if (!isV7Deployed) {
        const deployHash = await walletClient.sendTransaction({
            chain: publicClient.chain,
            to: args.deterministicDeployerAddress,
            data: concat([
                pimlicoEntrypointSimulationsSalt,
                pimlicoEntrypointSimulationsV7DeployBytecode
            ])
        })

        await publicClient.waitForTransactionReceipt({
            hash: deployHash
        })
    }

    if (!isV8Deployed) {
        const deployHash = await walletClient.sendTransaction({
            chain: publicClient.chain,
            to: args.deterministicDeployerAddress,
            data: concat([
                pimlicoEntrypointSimulationsSalt,
                pimlicoEntrypointSimulationsV8DeployBytecode
            ])
        })

        await publicClient.waitForTransactionReceipt({
            hash: deployHash
        })
    }

    const deployStatus = await Promise.all([
        isContractDeployed({ publicClient, address: contractAddressV7 }),
        isContractDeployed({ publicClient, address: contractAddressV8 })
    ])

    if (deployStatus[0] && deployStatus[1]) {
        return {
            entrypointSimulationContractV7: contractAddressV7,
            entrypointSimulationContractV8: contractAddressV8
        }
    }

    throw new Error("Failed to deploy simulationsContract")
}
