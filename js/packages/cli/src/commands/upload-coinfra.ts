import { createCandyMachineCoinfra } from '../helpers/accounts-coinfra';
import { sendSignedTransaction } from '../helpers/transactions';
import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, Program, web3, Wallet } from '@project-serum/anchor';
import { chunks, fromUTF8Array } from '../helpers/various-coinfra';
import {
  CONFIG_LINE_SIZE_V2,
  CONFIG_ARRAY_START_V2,
} from '../helpers/constants';
import * as anchor from '@project-serum/anchor';

export async function uploadCoinfra({
  totalNFTs,
  retainAuthority,
  mutable,
  price,
  treasuryWallet,
  splToken,
  gatekeeper,
  goLiveDate,
  endSettings,
  whitelistMintSettings,
  hiddenSettings,
  uuid,
  wallet,
  anchorProgram,
  metadatas,
  currentCacheContent,
}: {
  cacheName: string;
  env: string;
  totalNFTs: number;
  retainAuthority: boolean;
  mutable: boolean;
  price: BN;
  treasuryWallet: PublicKey;
  splToken: PublicKey | null;
  gatekeeper: null | {
    expireOnUse: boolean;
    gatekeeperNetwork: web3.PublicKey;
  };
  goLiveDate: null | BN;
  endSettings: null | [number, BN];
  whitelistMintSettings: null | {
    mode: any;
    mint: PublicKey;
    presale: boolean;
    discountPrice: null | BN;
  };
  hiddenSettings: null | {
    name: string;
    uri: string;
    hash: Uint8Array;
  };
  uuid: string;
  wallet: Wallet;
  anchorProgram: Program;
  metadatas: any[];
  currentCacheContent: string;
}): Promise<{
  cacheContent: any;
  error: Error;
}> {
  const SIZE = metadatas.length;
  console.log('currentCacheContent');
  console.log(currentCacheContent);

  const cacheContent: any = currentCacheContent || {};
  console.log('cacheContent');
  console.log(cacheContent);

  if (SIZE === 0) {
    const error = new Error('Your manifests file is invalid');
    console.error(error.message);
    throw error;
  }

  let candyMachine = cacheContent.program.candyMachine
    ? new PublicKey(cacheContent.program.candyMachine)
    : undefined;

  if (!cacheContent.program.uuid) {
    const firstAssetManifest = metadatas[0];

    try {
      if (
        !firstAssetManifest.properties?.creators?.every(
          creator => creator.address !== undefined,
        )
      ) {
        throw new Error('Creator address is missing');
      }

      // initialize candy
      console.log(`initializing candy machine`);

      const res = await createCandyMachineCoinfra(
        anchorProgram,
        wallet,
        treasuryWallet,
        splToken,
        {
          itemsAvailable: new BN(totalNFTs),
          uuid,
          symbol: firstAssetManifest.symbol,
          sellerFeeBasisPoints: firstAssetManifest.seller_fee_basis_points,
          isMutable: mutable,
          maxSupply: new BN(0),
          retainAuthority: retainAuthority,
          gatekeeper,
          goLiveDate,
          price,
          endSettings,
          whitelistMintSettings,
          hiddenSettings,
          creators: firstAssetManifest.properties.creators.map(creator => {
            return {
              address: new PublicKey(creator.address),
              verified: true,
              share: creator.share,
            };
          }),
        },
      );
      cacheContent.program.uuid = res.uuid;
      cacheContent.program.candyMachine = res.candyMachine.toBase58();
      candyMachine = res.candyMachine;

      console.info(
        `initialized config for a candy machine with publickey: ${res.candyMachine.toBase58()}`,
      );
    } catch (error) {
      console.error('Error deploying config to Solana network.', error);
      throw error;
    }
    console.log('Uploading Size', SIZE, firstAssetManifest);
  } else {
    console.log(
      `config for a candy machine with publickey: ${cacheContent.program.candyMachine} has been already initialized`,
    );
  }

  const keys = Object.keys(cacheContent.items);
  if (!hiddenSettings) {
    try {
      // add config to candy machine from cacheContent.items
      const TRANSACTION_SIZE = 5;
      const allIndexesInSlices: number[][] = slice(
        Array.from(Array(keys.length).keys()),
        500, // need to sign each 500 NFTS(100 txs) for preventing from the hangup of the Phantom wallet
      );
      console.log('allIndexesInSlices');
      console.log(allIndexesInSlices);
      for (const allIndexesInSlice of allIndexesInSlices) {
        const unsignedTransactions: Transaction[] = [];
        const completeIndexes: string[] = [];

        // skip if allIndexesInSlice is already onchain
        const onChain = allIndexesInSlice.filter(i => {
          return cacheContent.items[keys[i]]?.onChain || false;
        });
        if (onChain.length === allIndexesInSlice.length) {
          continue;
        }

        // From Genesys Go
        // Call a blockhash a few seconds older which will have been synced across all machines ledgers.
        // The closer you are to the very tip of the ledger, the more likely it is you will see errors bc
        // the newest valid blocks have not had a chance to propagate across the entire chain and the bad forks have not yet been pruned.
        const recentBlockhash =
          await anchorProgram.provider.connection.getRecentBlockhash(
            'singleGossip',
          );
        // if TRANSACTION_SIZE is larger than 10, "RangeError: encoding overruns Buffer" will occur
        for (
          let offset = 0;
          offset < allIndexesInSlice.length;
          offset += TRANSACTION_SIZE
        ) {
          const indexes = allIndexesInSlice.slice(
            offset,
            offset + TRANSACTION_SIZE,
          );
          const onChain = indexes.filter(i => {
            return cacheContent.items[keys[i]]?.onChain || false;
          });
          const ind = keys[indexes[0]];

          if (onChain.length != indexes.length) {
            console.info(
              `Writing indices ${ind}-${keys[indexes[indexes.length - 1]]}`,
            );
            try {
              const transaction = anchorProgram.transaction.addConfigLines(
                ind,
                indexes.map(i => {
                  return {
                    uri: cacheContent.items[keys[i]].link,
                    name: cacheContent.items[keys[i]].name,
                  };
                }),
                {
                  accounts: {
                    candyMachine,
                    authority: wallet.publicKey,
                  },
                },
              );
              transaction.feePayer = wallet.publicKey;
              transaction.recentBlockhash = recentBlockhash.blockhash;
              unsignedTransactions.push(transaction);
              indexes.forEach(i => {
                completeIndexes.push(keys[i]);
              });
            } catch (error) {
              console.error(
                `saving config line ${ind}-${
                  keys[indexes[indexes.length - 1]]
                } failed`,
                error,
              );
            }
          }
        }
        // send transactions
        const signedTransactions = await wallet.signAllTransactions(
          unsignedTransactions,
        );
        const pendingTransactions: Promise<{
          txid: string;
          slot: number;
        }>[] = [];
        for (const signedTransaction of signedTransactions) {
          pendingTransactions.push(
            sendSignedTransaction({
              connection: anchorProgram.provider.connection,
              signedTransaction: signedTransaction,
            }).catch(reason => {
              throw new Error(`failed transaction: ${reason}`);
            }),
          );
        }
        // wait the confirmation of transactions
        const result = await Promise.all(pendingTransactions);
        console.log(result);
        // change cache
        completeIndexes.forEach(v => {
          cacheContent.items[v] = {
            ...cacheContent.items[v],
            onChain: true,
            verifyRun: false,
          };
        });
      }
    } catch (error) {
      return {
        cacheContent,
        error,
      };
    }
  } else {
    console.info('Skipping upload to chain as this is a hidden Candy Machine');
  }

  console.log(`Done. Successful!`);
  return {
    cacheContent,
    error: undefined,
  };
}

export async function verifyUploadCoinfra({
  anchorProgram,
  cacheContent,
}: {
  anchorProgram: Program;
  cacheContent: any;
}): Promise<string> {
  const candyMachine = await anchorProgram.provider.connection.getAccountInfo(
    new PublicKey(cacheContent.program.candyMachine),
  );

  const candyMachineObj = await anchorProgram.account.candyMachine.fetch(
    new PublicKey(cacheContent.program.candyMachine),
  );
  let allGood = true;

  const keys = Object.keys(cacheContent.items)
    .filter(k => !cacheContent.items[k].verifyRun)
    .sort((a, b) => Number(a) - Number(b));

  console.log('Key size', keys.length);
  await Promise.all(
    chunks(keys, 500).map(async allIndexesInSlice => {
      for (let i = 0; i < allIndexesInSlice.length; i++) {
        // Save frequently.
        /*
        if (i % 100 == 0) saveCache(cacheName, env, cacheContent);
        */
        const key = allIndexesInSlice[i];
        console.log('Looking at key ', key);

        const thisSlice = candyMachine.data.slice(
          CONFIG_ARRAY_START_V2 + 4 + CONFIG_LINE_SIZE_V2 * key,
          CONFIG_ARRAY_START_V2 + 4 + CONFIG_LINE_SIZE_V2 * (key + 1),
        );
        console.log('thisSlice');
        console.log(thisSlice);

        const name = fromUTF8Array([...thisSlice.slice(2, 34)]);
        const uri = fromUTF8Array([...thisSlice.slice(40, 240)]);
        const cacheItem = cacheContent.items[key];
        if (!name.match(cacheItem.name) || !uri.match(cacheItem.link)) {
          // leaving here for debugging reasons, but it's pretty useless. if the first upload fails - all others are wrong
          console.log(
            `Name (${name}) or uri (${uri}) didnt match cache values of (${cacheItem.name})` +
              `and (${cacheItem.link}). marking to rerun for image`,
            key,
          );
          // cacheItem.onChain = false; // Even if the candy machine doesn't propagate across the network, cacheItem.onChain will turn off. So I comment out this line.
          allGood = false;
        } else {
          cacheItem.verifyRun = true;
        }
      }
    }),
  );

  if (!allGood) {
    // saveCache(cacheName, env, cacheContent);
    console.log('cacheContent', cacheContent);
    throw new Error(
      "The name or URI didn't match the cache values. Please wait for a moment until your candy machine propagates across the network.",
    );
  }

  const lineCount = new anchor.BN(
    candyMachine.data.slice(CONFIG_ARRAY_START_V2, CONFIG_ARRAY_START_V2 + 4),
    undefined,
    'le',
  );

  console.log(
    `uploaded (${lineCount.toNumber()}) out of (${
      candyMachineObj.data.itemsAvailable
    })`,
  );
  if (candyMachineObj.data.itemsAvailable > lineCount.toNumber()) {
    throw new Error(
      `predefined number of NFTs (${
        candyMachineObj.data.itemsAvailable
      }) is smaller than the uploaded one (${lineCount.toNumber()})`,
    );
  } else {
    console.log('ready to deploy!');
  }
  return cacheContent;
}

function slice(items: any, batchSize: number) {
  return items.reduce((resultArray: any, item: any, index: number) => {
    const chunkIndex = Math.floor(index / batchSize);
    if (!resultArray[chunkIndex]) {
      resultArray[chunkIndex] = []; // start a new chunk
    }
    resultArray[chunkIndex].push(item);
    return resultArray;
  }, []);
}
