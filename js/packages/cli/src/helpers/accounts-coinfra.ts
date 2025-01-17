import {
  Keypair,
  PublicKey,
  SystemProgram,
  AccountInfo,
  Connection,
} from '@solana/web3.js';
import { CANDY_MACHINE_PROGRAM_V2_ID } from './constants';
import * as anchor from '@project-serum/anchor';
import { createCandyMachineV2Account } from './instructions';
import { web3 } from '@project-serum/anchor';
import log from 'loglevel';
import { getCluster } from './various-coinfra';

export type AccountAndPubkey = {
  pubkey: string;
  account: AccountInfo<Buffer>;
};

export type StringPublicKey = string;

export enum WhitelistMintMode {
  BurnEveryTime,
  NeverBurn,
}
export interface CandyMachineData {
  itemsAvailable: anchor.BN;
  uuid: null | string;
  symbol: string;
  sellerFeeBasisPoints: number;
  isMutable: boolean;
  maxSupply: anchor.BN;
  price: anchor.BN;
  retainAuthority: boolean;
  gatekeeper: null | {
    expireOnUse: boolean;
    gatekeeperNetwork: web3.PublicKey;
  };
  goLiveDate: null | anchor.BN;
  endSettings: null | [number, anchor.BN];
  whitelistMintSettings: null | {
    mode: WhitelistMintMode;
    mint: anchor.web3.PublicKey;
    presale: boolean;
    discountPrice: null | anchor.BN;
  };
  hiddenSettings: null | {
    name: string;
    uri: string;
    hash: Uint8Array;
  };
  creators: {
    address: PublicKey;
    verified: boolean;
    share: number;
  }[];
}

export function uuidFromConfigPubkey(configAccount: PublicKey) {
  return configAccount.toBase58().slice(0, 6);
}

export async function loadCandyProgramCoinfra(
  wallet: anchor.Wallet,
  env: string,
  customRpcUrl?: string,
) {
  if (customRpcUrl) console.log('USING CUSTOM URL', customRpcUrl);

  // @ts-ignore
  const solConnection = new anchor.web3.Connection(
    //@ts-ignore
    customRpcUrl || getCluster(env),
  );

  const provider = new anchor.Provider(solConnection, wallet, {
    preflightCommitment: 'recent',
  });
  const idl = await anchor.Program.fetchIdl(
    CANDY_MACHINE_PROGRAM_V2_ID,
    provider,
  );
  const program = new anchor.Program(
    idl,
    CANDY_MACHINE_PROGRAM_V2_ID,
    provider,
  );
  log.debug('program id from anchor', program.programId.toBase58());
  return program;
}

export const createCandyMachineCoinfra = async function (
  anchorProgram: anchor.Program,
  wallet: anchor.Wallet,
  treasuryWallet: PublicKey,
  splToken: PublicKey,
  candyData: CandyMachineData,
) {
  const candyAccount = Keypair.generate();
  candyData.uuid = uuidFromConfigPubkey(candyAccount.publicKey);

  if (!candyData.creators || candyData.creators.length === 0) {
    throw new Error(`Invalid config, there must be at least one creator.`);
  }

  const totalShare = (candyData.creators || []).reduce(
    (acc, curr) => acc + curr.share,
    0,
  );

  if (totalShare !== 100) {
    throw new Error(`Invalid config, creators shares must add up to 100`);
  }

  const remainingAccounts = [];
  if (splToken) {
    remainingAccounts.push({
      pubkey: splToken,
      isSigner: false,
      isWritable: false,
    });
  }

  let txId;
  try {
    // for estimating the cost, execute initializeCandyMachine at first
    txId = await anchorProgram.rpc.initializeCandyMachine(candyData, {
      accounts: {
        candyMachine: candyAccount.publicKey,
        wallet: treasuryWallet,
        authority: wallet.publicKey,
        payer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [candyAccount],
      remainingAccounts:
        remainingAccounts.length > 0 ? remainingAccounts : undefined,
      instructions: [
        await createCandyMachineV2Account(
          anchorProgram,
          candyData,
          wallet.publicKey,
          candyAccount.publicKey,
        ),
      ],
    });
  } catch (error) {
    console.error(error);
    const hasConfirmed = await checkTransaction(
      error.message,
      anchorProgram.provider.connection,
    );
    // If transaction isn't confirmed, throw error.
    if (!hasConfirmed) {
      throw error;
    }
  }

  return {
    candyMachine: candyAccount.publicKey,
    uuid: candyData.uuid,
    txId,
  };
};

// If the below error, check the transaction. If it's confirmed, return true.
// `Error: Transaction was not confirmed in 60.00 seconds. It is unknown if it succeeded or failed. Check signature ${txId} using the Solana Explorer or CLI tools.`
export const checkTransaction = async (
  error: string,
  connection: Connection,
) => {
  if (error.indexOf('Check signature') === -1) return false;
  const signature = error.match(/.* Check signature (.*) using .*/).pop();
  console.log('signature', signature);
  // If transaction is null, transaction isn't confirmed. <reference>https://docs.solana.com/developing/clients/jsonrpc-api#results-42
  const transaction = await connection.getConfirmedTransaction(signature);
  console.log('transaction', transaction);
  return Boolean(transaction);
};
