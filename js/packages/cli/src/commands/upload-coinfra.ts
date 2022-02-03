import { createCandyMachineCoinfra } from '../helpers/accounts-coinfra';
import { chunks } from '../helpers/various-coinfra';
import { sendSignedTransaction } from '../helpers/transactions';
import { PublicKey, Transaction } from '@solana/web3.js';
import { BN, Program, web3, Wallet } from '@project-serum/anchor';

export async function uploadCoinfra({
  totalNFTs,
  retainAuthority,
  mutable,
  batchSize,
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
  manifests,
  metadataLinks,
}: {
  cacheName: string;
  env: string;
  totalNFTs: number;
  retainAuthority: boolean;
  mutable: boolean;
  batchSize: number;
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
  manifests: any[];
  metadataLinks: string;
}): Promise<{
  uploadSuccessful: boolean;
  cacheContent: any;
}> {
  let uploadSuccessful = true;
  const cacheContent: any = { program: {}, items: {} };

  const SIZE = manifests.length;

  if (SIZE === 0) {
    const error = new Error('Your manifests file is invalid');
    console.error(error.message);
    throw error;
  }

  const firstAssetManifest = manifests[0];

  let candyMachine;
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

  // add config to cacheContent.items
  await Promise.all(
    chunks(Array.from(Array(SIZE).keys()), batchSize || 50).map(
      async allIndexesInSlice => {
        for (let i = 0; i < allIndexesInSlice.length; i++) {
          const manifest = manifests[allIndexesInSlice[i]];
          const metadataLink = metadataLinks[allIndexesInSlice[i]];

          console.debug('Updating cache for ', allIndexesInSlice[i]);
          cacheContent.items[allIndexesInSlice[i]] = {
            link: metadataLink,
            name: manifest.name,
            onChain: false,
          };
        }
      },
    ),
  );

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
      for await (const allIndexesInSlice of allIndexesInSlices) {
        const unsignedTransactions: Transaction[] = [];
        // From Genesys Go
        // Call a blockhash a few seconds older which will have been synced across all machines ledgers.
        // The closer you are to the very tip of the ledger, the more likely it is you will see errors bc
        // the newest valid blocks have not had a chance to propagate across the entire chain and the bad forks have not yet been pruned.
        const recentBlockhash =
          await anchorProgram.provider.connection.getRecentBlockhash(
            'singleGossip',
          );
        // if this value is large like 10, "RangeError: encoding overruns Buffer" occur
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
            const index = keys[i];
            return cacheContent.items[index]?.onChain || false;
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
                cacheContent.items[keys[i]] = {
                  ...cacheContent.items[keys[i]],
                  onChain: true,
                  verifyRun: false,
                };
              });
            } catch (error) {
              console.error(
                `saving config line ${ind}-${
                  keys[indexes[indexes.length - 1]]
                } failed`,
                error,
              );
              uploadSuccessful = false;
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
      }
    } catch (error) {
      uploadSuccessful = false;
      throw error;
    }
  } else {
    console.info('Skipping upload to chain as this is a hidden Candy Machine');
  }

  console.log(`Done. Successful! = ${uploadSuccessful}.`);
  return {
    uploadSuccessful,
    cacheContent,
  };
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
