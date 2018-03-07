## Swift 4 dependency analyzer

_This is very much work in progress... more "productization" hopefully coming soon._

### Installation

  First run
  
    yarn install

### Using the tool
  * First you must customize the `bin/index.js` to fill in your 
  project name and a couple other details that dep-checker uses to identify the correct set of .swifdeps
  files
  
  * Then you can run the `index.js` script in your XCode workspace root like this:
    * `node ..pathto/pelam-swift-dep-checker/bin/index.js`

### Why the tool considers files

Note that the tool considers dependencies between .swift files _as opposed to between swift types._
The reason for this is twofold:
  * Of course your file structure should mirror your intended code dependency structure
  * Compiling too many _files_ are the thing that make compile take long.
    * (Swift incremental compile works at the file level)
  
### What the tool does

  * Finds the Derived data directories
  * Find the correct build directory (matching architecture, config, etc)
  * Reads the .swiftdeps files (1 file per each .swift file)
  * Creates a swift file dependency graph
  * Finds cycles in the graph
  * outputs Graphviz compatible `output.dot` file with just the files involved in cycles
  
### Inspecting the results

After the tool has generated the `output.dot` file you can either:

  1. Inspect the .dot file to see which file depends on which other files
  2. Run graphiviz and create a pretty picture
     * I have currently created pictures as follows:
      `dot -x -Goverlap=scale -Gconcentrate=true -Tsvg output.dot -o output.svg`
     *  Open the `output.svg` in Inkscape
     * Use Inkscape print to file function to create .pdf for general viewing and consumption (.pdf support seems to
     be better than .svg support)
     * NOTE: graphviz has multiple output capabilities so you can easily create your own workflow to visualize the results
