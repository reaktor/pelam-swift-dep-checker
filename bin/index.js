const Bacon = require('baconjs')
const fs = require('fs')
const createLineStream = require('bacon-node-line-stream')
const path = require('path')
const R = require('ramda')
const os = require('os')
const plist = require('fast-plist')
const walk = require('walk')
const process = require('process')

const cwd = process.cwd()

const swiftdepsFileRegex = /.*\.swiftdeps$/

const derivedDataDir = path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData')

// /Build/Intermediates.noindex/(PROJECT).build/DEBUGRELEASE-PLATFORM/TARGET.build/Objects-normal/ARCH/
//                                 1               2          3            4                       5
const objectsFolderRegex = /^\/Build\/Intermediates.noindex\/([^\/]+).build\/([^\/]+)-([^\/]+)\/([^\/]+).build\/Objects-normal\/([^\/]+)$/;

// TODO: Make these command line options
// IMPORTANT NOTE! You must do a full rebuild and NOT have -Owhole-module-optimization on, otherwise it won't write the .swiftdeps files

// Configure these to match your last full rebuild
const project = "NAME-OF-YOUR-WORKSPACE-HERE"
const architecture = "arm64" // armv7, i386
const buildConfig = "Debug"
const target = "NAME-OF-YOUR-TARGET-HERE"
const platform = "iphoneos"

const directoryToDirContents = (data) =>
  Bacon.fromNodeCallback(fs.readdir, data.swiftDepsDir)
    //.map(foo => foo.filter(bar => swiftdepsFileRegex.test(bar)))
    .map(R.filter(f => swiftdepsFileRegex.test(f)))
    .map(files => R.merge(data, {files}))

const dirContentsToFiles = (data) =>
  Bacon.fromArray(
    data.files
      .map(file => R.merge(R.dissoc('files', data), {file}))
  )

const fileNameStream =
  Bacon.fromNodeCallback(fs.readdir, derivedDataDir)
    .doAction(dirs => {
      console.log("Scanning", dirs.length, "subdirectories in", derivedDataDir, "for matching build files")
    })
    .flatMap(Bacon.fromArray) // to individual items
    .map(subdir => {
      const derivedDataSubDir = path.join(derivedDataDir, subdir)
      return ({derivedDataSubDir}) // to paths
    })
    .map(data => R.merge(data, {derivedDataInfoPlistPath: path.join(data.derivedDataSubDir, 'info.plist')}))
    .filter(data => fs.existsSync(data.derivedDataInfoPlistPath))
    .flatMap(readDerivedDataPlist)
    .filter(isValidDerivedDataDir)
    .flatMap( data => {
      const options = {
        followLinks: false,
        filters: ["Index", "Products", "Logs"] // XCode index is big... ignore it
      };

      const walker = walk.walk(data.derivedDataSubDir, options)

      return Bacon.fromBinder(sink => {
        walker.on("directory", (root, dirStatsArray, next) => {
          const rootPart = root.substring(data.derivedDataSubDir.length)
          const swiftDepsDirPart = path.join(rootPart, dirStatsArray.name) // only potential dir at this point
          const match = objectsFolderRegex.exec(swiftDepsDirPart)
          if (match) {
            const [_, project, buildConfig, platform, target, architecture] = match
            const swiftDepsDir = path.join(root, dirStatsArray.name) // only potential dir at this point
            const newData = R.merge(data, {swiftDepsDir, project, buildConfig, platform, target, architecture})
            sink(Bacon.Next(newData))
          }
          return next()
        })
        walker.on("end", () => sink(new Bacon.End()))
      })
    })
    .fold([], R.flip(R.append)) // to 1 big array
    .flatMap(datas => {
      const accepted = datas
        .sort(x => x.derivedDataInfoPlist.LastAccessedDate + x.swiftDepsDir)
        .filter(data =>
        data.project === project && data.buildConfig === buildConfig && data.platform === platform && data.target === target && data.architecture === architecture)

      if (accepted.length == 0) {
        const opts = datas.map(data => `project: ${data.project}, buildConfig: ${data.buildConfig}, platform: ${data.platform}, target: ${data.target}, architecture: ${data.architecture}`)
        const optsJoined = R.join("\n", R.uniq(opts))
        if (datas.length > 0) {
          return Bacon.once(Bacon.Error(`${optsJoined}\nNo matching objects folder found!\nPlease specify one of the above.`))
        } else {
          return Bacon.once(Bacon.Error(`No derived data folders found.
          Make sure you run the script in your XCode workspace root.
          You must also do a full rebuild before hand and YOU MUST NOT have -Owhole-module-optimization on.
          (otherwise swiftc won't write the .swiftdeps files.)
          `))
        }
      } else {
        const chosen = accepted[0]
        console.log("Analyzing dependencies based on .swiftdeps files in:\n  ", chosen.swiftDepsDir, "\n  last modified date:", chosen.derivedDataInfoPlist.LastAccessedDate)
        return Bacon.once(chosen) // take the most recently accessed derived data dir
      }
    })
    .flatMap(directoryToDirContents)
    .flatMap(dirContentsToFiles)

function removeSuffix(filePath) {
  return filePath.replace(/\.\w+$/,"")
}

function addFileProps(data) {
  const combinedPath = path.join(data.swiftDepsDir, data.file)
  const fileDepId = removeSuffix(data.file).replace(/\W/g, '_') // TODO: Better way to do this?
  return R.merge(data, {combinedPath, fileDepId})
}

function addFileStream(data) {
  return R.merge(data, {stream: fs.createReadStream(data.combinedPath)})
}

const fileStreamsToLineStream = (data) =>
  createLineStream(data.stream)
    .map(line => R.merge(R.dissoc('stream', data), {line}))

const swiftdepGroupRegex = /^\s*([\w-]+)\s*:\s*$/
const swiftDepRegex = /^\s*-\s*(!private)?\s*"(\w+)"\s*$/

const addGroupsStateMachine = (group, event) => {
  if (event.hasValue()) {
    const data = event.value()
    const match = swiftdepGroupRegex.exec(data.line)
    if (match) {
      const newGroup = match[1]
      return [newGroup, []]
    } else {
      const matchDep = swiftDepRegex.exec(data.line)
      if (matchDep) {
        const dep = matchDep[2]
        return [group, [new Bacon.Next(R.merge(data, {group, dep}))]]
      } else {
        return [group, []]
      }
    }
  } else {
    return [undefined, [event]]
  }
}

function filterDependantsTodeps(predicate, dependantsToDeps) {
  const wholeDependantsRemoved = R.pickBy((dependantDeps, dependant) => predicate(dependant), dependantsToDeps)
  return R.mapObjIndexed(dependantDeps => dependantDeps.filter(predicate), wholeDependantsRemoved)
}

const dependsTopLevel = 'depends-top-level'
const providesTopLevel = 'provides-top-level'

const acceptedGroups = [dependsTopLevel, providesTopLevel]

fileNameStream
  .map(addFileProps)
  .map(addFileStream)
  .flatMap(fileStreamsToLineStream)
  .withStateMachine(undefined, addGroupsStateMachine)
  .filter(x => acceptedGroups.includes(x.group))
  .fold([], R.flip(R.append)) // to 1 big array
  .map(datas => {
    const providers = {}
    datas.filter(data => data.group === providesTopLevel).forEach(data => {
      if (providers[data.dep]) {
        providers[data.dep].push(data.fileDepId)
      } else {
        providers[data.dep] = [data.fileDepId]
      }
    })

    const dependants = R.groupBy(R.prop('fileDepId'), datas.filter(data => data.group === dependsTopLevel))

    const resolveDeps = R.pipe(
      R.map(data => providers[data.dep] || []),
      R.flatten,
      R.uniq)

    const dependantsToDeps = R.mapObjIndexed((datas, fileDepId) => resolveDeps(datas).filter(x => x !== fileDepId), dependants)

    return dependantsToDeps
  })
  .map(dependantsToDeps => {
    // basic depth first search / topological sort, but we are just interested in the cycles now
    // https://stackoverflow.com/a/41878935/1148030
    const temporarilyMarkedStack = []
    const permanentlyMarked = {}
    const loopParticipants = {}

    function depthFirstSearch(dependant) {
      if (temporarilyMarkedStack.includes(dependant)) {
        // loop detected, mark involved nodes as loop participants
        const loop = temporarilyMarkedStack.slice(temporarilyMarkedStack.indexOf(dependant))
        loop.forEach(x => loopParticipants[x] = true)
      } else if (!permanentlyMarked.hasOwnProperty(dependant)) {
        temporarilyMarkedStack.push(dependant)
        dependantsToDeps[dependant].forEach(depthFirstSearch)
        temporarilyMarkedStack.pop()
        permanentlyMarked[dependant] = true
      }
    }

    R.forEachObjIndexed(dependantDeps =>
      dependantDeps.forEach(dependant => {
        if (!permanentlyMarked.hasOwnProperty(dependant)) {
          depthFirstSearch(dependant)
        }
      })
      ,dependantsToDeps)

    // console.log("Loop participants", JSON.stringify(R.keys(loopParticipants), null, 2))

    return {dependantsToDeps, loopParticipants}
  })
  .map(data => {
    const dependantsToDeps = filterDependantsTodeps(dependant => data.loopParticipants.hasOwnProperty(dependant), data.dependantsToDeps)
    // console.log("Filtered only loop participating", JSON.stringify(dependantsToDeps, null, 2))
    return R.merge(data, {dependantsToDeps})
  })
  .map(({dependantsToDeps}) =>
    R.mapObjIndexed((dependantDeps, dependant) => dependant + " -> { " + dependantDeps.reduce((acc, dep) => acc + dep + " ", "") + "}", dependantsToDeps))
  .map(R.values)
  .map(dagRows => dagRows.reduce((acc, row) => acc + "  " + row + ";\n", ""))
  .map(dag => `digraph {\n  rankdir=LR;\n${dag}}`)
  .map(dotFileContent => {
    fs.writeFile("output.dot", dotFileContent)
    return "Wrote output.dot"
  })
  .log()

function readDerivedDataPlist(data) {
  return Bacon.fromNodeCallback(fs.readFile, data.derivedDataInfoPlistPath, 'utf8').map( string => {
      return R.merge(data, {derivedDataInfoPlistString: string})
    }
  ).map(data => R.dissoc('derivedDataInfoPlistString', R.merge(data, {derivedDataInfoPlist: plist.parse(data.derivedDataInfoPlistString)})))
}

function isValidDerivedDataDir(data) {
  const workspacePath = data.derivedDataInfoPlist.WorkspacePath
  return workspacePath && workspacePath.startsWith(cwd) && data.derivedDataInfoPlist.LastAccessedDate
}