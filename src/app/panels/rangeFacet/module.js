/*

  ## Histogram

  ### Parameters
  * auto_int :: Auto calculate data point interval?
  * resolution ::  If auto_int is enables, shoot for this many data points, rounding to
                    sane intervals
  * interval :: Datapoint interval in elasticsearch date math format (eg 1d, 1w, 1y, 5y)
  * fill :: Only applies to line charts. Level of area shading from 0-10
  * linewidth ::  Only applies to line charts. How thick the line should be in pixels
                  While the editor only exposes 0-10, this can be any numeric value.
                  Set to 0 and you'll get something like a scatter plot
  * timezone :: This isn't totally functional yet. Currently only supports browser and utc.
                browser will adjust the x-axis labels to match the timezone of the user's
                browser
  * spyable ::  Dislay the 'eye' icon that show the last elasticsearch query
  * zoomlinks :: Show the zoom links?
  * bars :: Show bars in the chart
  * stack :: Stack multiple queries. This generally a crappy way to represent things.
             You probably should just use a line chart without stacking
  * points :: Should circles at the data points on the chart
  * lines :: Line chart? Sweet.
  * legend :: Show the legend?
  * x-axis :: Show x-axis labels and grid lines
  * y-axis :: Show y-axis labels and grid lines
  * interactive :: Allow drag to select time range

*/
define([
  'angular',
  'app',
  'jquery',
  'underscore',
  'kbn',
  'moment',
  './timeSeries',

  'jquery.flot',
  'jquery.flot.pie',
  'jquery.flot.selection',
  'jquery.flot.time',
  'jquery.flot.stack',
  'jquery.flot.stackpercent'
],
function (angular, app, $, _, kbn, moment, timeSeries) {
  'use strict';

  var DEBUG = true; // DEBUG mode

  var module = angular.module('kibana.panels.rangeFacet', []);
  app.useModule(module);

  module.controller('rangeFacet', function($scope, $q, querySrv, dashboard, filterSrv) {
    $scope.panelMeta = {
      modals : [
        {
          description: "Inspect",
          icon: "icon-info-sign",
          partial: "app/partials/inspector.html",
          show: $scope.panel.spyable
        }
      ],
      editorTabs : [
        {
          title:'Queries',
          src:'app/partials/querySelect.html'
        }
      ],
      status  : "Experimental",
      description : "A bucketed time series chart of the current query or queries. Uses the "+
        "Solr facet range. If using time stamped indices this panel will query"+
        " them sequentially to attempt to apply the lighest possible load to your Solr cluster"
    };

    // Set and populate defaults
    var _d = {
      mode        : 'count',
      time_field  : 'timestamp',
      queries     : {
        mode        : 'all',
        ids         : [],
        query       : '*:*',
        custom      : ''
      },
      max_rows    : 100000,  // maximum number of rows returned from Solr (also use this for group.limit to simplify UI setting)
      value_field : null,
      group_field : null,
      auto_int    : true,
      resolution  : 100,
      interval    : '5m',
      intervals   : ['auto','1s','1m','5m','10m','30m','1h','3h','12h','1d','1w','1M','1y'],
      fill        : 0,
      linewidth   : 3,
      timezone    : 'browser', // browser, utc or a standard timezone
      spyable     : true,
      zoomlinks   : true,
      bars        : true,
      stack       : true,
      points      : false,
      lines       : false,
      lines_smooth: false, // Enable 'smooth line' mode by removing zero values from the plot.
      legend      : true,
      'x-axis'    : true,
      'y-axis'    : true,
      percentage  : false,
      interactive : true,
      options     : true,
      tooltip     : {
        value_type: 'cumulative',
        query_as_alias: false
      }
    };

    _.defaults($scope.panel,_d);

    $scope.init = function() {
      // Hide view options by default
      $scope.options = false;
      $scope.$on('refresh',function(){
        $scope.get_data();
      });

      $scope.get_data();

    };

    $scope.set_interval = function(interval) {
      if(interval !== 'auto') {
        $scope.panel.auto_int = false;
        $scope.panel.interval = interval;
      } else {
        $scope.panel.auto_int = true;
      }
    };

    $scope.interval_label = function(interval) {
      return $scope.panel.auto_int && interval === $scope.panel.interval ? interval+" (auto)" : interval;
    };

    /**
     * The time range effecting the panel
     * @return {[type]} [description]
     */
    $scope.get_time_range = function () {
      var range = $scope.range = filterSrv.timeRange('min');
      return range;
    };

    $scope.get_facet_range = function () {
      var range = $scope.facet_range = filterSrv.facetRange();
      return range;
    };

    $scope.set_range_filter = function(){
      filterSrv.removeByType('range');
      filterSrv.set({
        type: 'range',
        from: parseInt($scope.panel.minimum),
        to: parseInt($scope.panel.maximum),
        field: $scope.panel.range_field
      });
      dashboard.refresh();
    }

    $scope.set_configrations = function(from,to){
      $scope.panel.minimum = from;
      $scope.panel.maximum = to;
    }

    $scope.get_interval = function () {
      var interval = $scope.panel.interval,
                      range;
      if ($scope.panel.auto_int) {
        range = $scope.get_time_range();
        if (range) {
          interval = kbn.secondsToHms(
            kbn.calculate_interval(range.from, range.to, $scope.panel.resolution, 0) / 1000
          );
        }
      }
      $scope.panel.interval = interval || '10m';
      return $scope.panel.interval;
    };

    /**
     * Fetch the data for a chunk of a queries results. Multiple segments occur when several indicies
     * need to be consulted (like timestamped logstash indicies)
     *
     * The results of this function are stored on the scope's data property. This property will be an
     * array of objects with the properties info, time_series, and hits. These objects are used in the
     * render_panel function to create the historgram.
     *
     * !!! Solr does not need to fetch the data in chunk because it uses a facet search and retrieve
     * !!! all events from a single query.
     *
     * @param {number} segment   The segment count, (0 based)
     * @param {number} query_id  The id of the query, generated on the first run and passed back when
     *                            this call is made recursively for more segments
     */
    $scope.get_data = function(segment, query_id) {
      if (_.isUndefined(segment)) {
        segment = 0;
      }
      delete $scope.panel.error;

      // Make sure we have everything for the request to complete
      if(dashboard.indices.length === 0) {
        return;
      }
      var _range = $scope.get_time_range();
      var _interval = $scope.get_interval(_range);

      if ($scope.panel.auto_int) {
        $scope.panel.interval = kbn.secondsToHms(
          kbn.calculate_interval(_range.from,_range.to,$scope.panel.resolution,0)/1000);
      }

      $scope.panelMeta.loading = true;

      // Solr
      $scope.sjs.client.server(dashboard.current.solr.server + dashboard.current.solr.core_name);

      if (DEBUG) { console.debug('RangeFacet:\n\tdashboard=',dashboard,'\n\t$scope=',$scope,'\n\t$scope.panel=',$scope.panel,'\n\tquerySrv=',querySrv,'\n\tfilterSrv=',filterSrv); }

      var request = $scope.sjs.Request().indices(dashboard.indices[segment]);
      $scope.panel.queries.ids = querySrv.idsByMode($scope.panel.queries);
      
      // Build the query
      _.each($scope.panel.queries.ids, function(id) {
        var query = $scope.sjs.FilteredQuery(
          querySrv.getEjsObj(id),
          filterSrv.getBoolFilter(filterSrv.ids)
        );

        var facet = $scope.sjs.DateHistogramFacet(id);

        if($scope.panel.mode === 'count') {
          facet = facet.field($scope.panel.time_field);
        } else {
          if(_.isNull($scope.panel.value_field)) {
            $scope.panel.error = "In " + $scope.panel.mode + " mode a field must be specified";
            return;
          }
          facet = facet.keyField($scope.panel.time_field).valueField($scope.panel.value_field);
        }
        facet = facet.interval(_interval).facetFilter($scope.sjs.QueryFilter(query));

        request = request.facet(facet).size(0);
      });

      // Populate the inspector panel
      $scope.populate_modal(request);

      // Build Solr query
      var fq = '&' + filterSrv.getSolrFq();
      var time_field = filterSrv.getTimeField();
      var start_time = filterSrv.getStartTime();
      var end_time = filterSrv.getEndTime();

      var wt_json = '&wt=json';
      var rows_limit = '&rows=0'; // for RangeFacet, we do not need the actual response doc, so set rows=0
      var facet_gap = $scope.sjs.convertFacetGap($scope.panel.interval);
      var facet = '&facet=true' +
                  '&facet.range=' + $scope.panel.range_field +
                  '&facet.range.start=' + $scope.panel.minimum +
                  '&facet.range.end=' + (parseInt($scope.panel.maximum)+1) +
                  '&facet.range.gap=' + $scope.panel.gap;
      var values_mode_query = '';

      // For mode = value
      if($scope.panel.mode === 'values') {
        if (!$scope.panel.value_field) {
            $scope.panel.error = "In " + $scope.panel.mode + " mode a field must be specified";
            return;
        }

        values_mode_query = '&fl=' + $scope.panel.time_field + ' ' + $scope.panel.value_field;
        rows_limit = '&rows=' + $scope.panel.max_rows;
        facet = '';

        // if Group By Field is specified
        if ($scope.panel.group_field) {
          values_mode_query += '&group=true&group.field=' + $scope.panel.group_field + '&group.limit=' + $scope.panel.max_rows;
        }
      }

      // Set the panel's query
      $scope.panel.queries.query = querySrv.getQuery(0) + wt_json + rows_limit + fq + facet + values_mode_query;
      // Set the additional custom query
      if ($scope.panel.queries.custom != null) {
        request = request.setQuery($scope.panel.queries.query + $scope.panel.queries.custom);
      } else {
        request = request.setQuery($scope.panel.queries.query);
      }

      var results = request.doSearch();

      // ==========================
      // SOLR - TEST Multiple Queries
      // ==========================
      // var mypromises = [];
      // mypromises.push(results);

      // var temp_q = 'q=' + dashboard.current.services.query.list[1].query + df + wt_json + rows_limit + fq + facet + filter_fq + fl;
      // request = request.setQuery(temp_q);
      // mypromises.push(request.doSearch());

      // if (dashboard.current.services.query.ids.length > 1) {
      //   _.each(dashboard.current.services.query.list, function(v,k) {
      //     if (DEBUG) { console.log('histogram:\n\tv=',v,', k=',k); }
      //     // TODO
      //   });
      //   $q.all(mypromises).then(function(myresults) {
      //     if (DEBUG) { console.log('histogram:\n\tmyresults=',myresults); }
      //     // TODO
      //   });
      // }
      // ========================
      // END SOLR TEST
      // ========================

      // Populate scope when we have results
      results.then(function(results) {
        _range = $scope.get_facet_range()
        if (DEBUG) { console.debug('RangeFacet:\n\trequest='+request+'\n\tresults=',results); }

        $scope.panelMeta.loading = false;
        if(segment === 0) {
          $scope.hits = 0;
          $scope.data = [];
          query_id = $scope.query_id = new Date().getTime();
        }

        // Check for error and abort if found
        if(!(_.isUndefined(results.error))) {
          $scope.panel.error = $scope.parse_error(results.error.msg);
          return;
        }

        // Convert facet ids to numbers
        // var facetIds = _.map(_.keys(results.facets),function(k){return parseInt(k, 10);});
        // TODO: change this, Solr do faceting differently
        var facetIds = [0]; // Need to fix this

        // Make sure we're still on the same query/queries
        // TODO: We probably DON'T NEED THIS unless we have to support multiple queries in query module.
        if($scope.query_id === query_id && _.difference(facetIds, $scope.panel.queries.ids).length === 0) {
          var i = 0,
            time_series,
            hits;

          _.each($scope.panel.queries.ids, function(id) {
            // var query_results = results.facets[id];

            if (DEBUG) { console.debug('facetrange: i=',i, '$scope=',$scope); }

            // we need to initialize the data variable on the first run,
            // and when we are working on the first segment of the data.
            if(_.isUndefined($scope.data[i]) || segment === 0) {
              time_series = new timeSeries.ZeroFilled({
                interval: _interval,
                start_date: _range && _range.from,
                end_date: _range && _range.to,
                fill_style: 'minimal'
              });
              hits = 0;
              if (DEBUG) { console.debug('\tfirst run: i='+i+', time_series=',time_series); }
            } else {
              if (DEBUG) { console.debug('\tNot first run: i='+i+', $scope.data[i].time_series=',$scope.data[i].time_series,', hits='+$scope.data[i].hits); }
              time_series = $scope.data[i].time_series;
              // Bug fix for wrong event count:
              //   Solr don't need to accumulate hits count since it can get total count from facet query.
              //   Therefore, I need to set hits and $scope.hits to zero.
              // hits = $scope.data[i].hits;
              hits = 0;
              $scope.hits = 0;
            }
            $scope.range_count = 0
            // Solr facet counts response is in one big array.
            // So no need to get each segment like Elasticsearch does.
            if ($scope.panel.mode === 'count') {
              // Entries from facet_ranges counts
              var entries = results.facet_counts.facet_ranges[$scope.panel.range_field].counts;
              for (var j = 0; j < entries.length; j++) {
                var entry_time = entries[j]; // convert to millisec
                j++;
                var entry_count = entries[j];
                time_series.addValue(entry_time, entry_count);
                hits += entry_count; // The series level hits counter
                $scope.hits += entry_count; // Entire dataset level hits counter
                $scope.range_count += 1
              };
            } else if ($scope.panel.mode === 'values') {
              if ($scope.panel.group_field) {
                // Group By Field is specified
                var groups = results.grouped[$scope.panel.group_field].groups;

                for (var j=0; j < groups.length; j++) {
                  var docs = groups[j].doclist.docs;
                  var group_time_series = new timeSeries.ZeroFilled({
                    interval: _interval,
                    start_date: _range && _range.from,
                    end_date: _range && _range.to,
                    fill_style: 'minimal'
                  });
                  hits = 0;

                  // loop through each group results
                  for (var k=0; k < docs.length; k++) {
                    var entry_time = new Date(docs[k][$scope.panel.time_field]).getTime(); // convert to millisec
                    var entry_value = docs[k][$scope.panel.value_field];
                    group_time_series.addValue(entry_time, entry_value);
                    hits += 1;
                    $scope.hits += 1;
                  }

                  $scope.data[j] = {
                    // info: querySrv.list[id],
                    // Need to define chart info here according to the results, cannot use querySrv.list[id]
                    info: {
                      alias: groups[j].groupValue,
                      color: querySrv.colors[j],

                    },
                    time_series: group_time_series,
                    hits: hits
                  };
                }
              } else { // Group By Field is not specified
                var entries = results.response.docs;
                for (var j=0; j < entries.length; j++) {
                  var entry_time = new Date(entries[j][$scope.panel.time_field]).getTime(); // convert to millisec
                  var entry_value = entries[j][$scope.panel.value_field];
                  time_series.addValue(entry_time, entry_value);
                  hits += 1;
                  $scope.hits += 1;
                }
                
                $scope.data[i] = {
                  info: querySrv.list[id],
                  time_series: time_series,
                  hits: hits
                };
              }
            }
            
            if ($scope.panel.mode !== 'values') {
              $scope.data[i] = {
                info: querySrv.list[id],
                time_series: time_series,
                hits: hits
              };
            }

            i++;
          });
          
          if (DEBUG) { console.debug('RangeFacet: Before render $scope=',$scope,'$scope.panel=',$scope.panel); }

          // Tell the RangeFacet directive to render.
          $scope.$emit('render');

          // Don't need this for Solr unless we need to support multiple queries.
          // If we still have segments left, get them
          // if(segment < dashboard.indices.length-1) {
          //   $scope.get_data(segment+1,query_id);
          // }
        }
      });
    };

    // function $scope.zoom
    // factor :: Zoom factor, so 0.5 = cuts timespan in half, 2 doubles timespan
    $scope.zoom = function(factor) {
      var _range = filterSrv.getByType('range')[1];
      if (_.isUndefined(_range))
        _range = {
          from: $scope.panel.minimum,
          to: $scope.panel.maximum
        }

      var _timespan = (_range.to.valueOf() - _range.from.valueOf());
      var _center = _range.to.valueOf() - _timespan/2;

      var _to = (_center + (_timespan*factor)/2);
      var _from = (_center - (_timespan*factor)/2);

      if(factor > 1) {
        filterSrv.removeByType('range');
      }
      var from = parseInt(_from);
      var to = parseInt(_to);
      filterSrv.set({
        type: 'range',
        from: from,
        to: to,
        field: $scope.panel.range_field
      });
      $scope.set_configrations(from,to)
      dashboard.refresh();

    };

    // I really don't like this function, too much dom manip. Break out into directive?
    $scope.populate_modal = function(request) {
      $scope.inspector = angular.toJson(JSON.parse(request.toString()),true);
    };

    $scope.set_refresh = function (state) {
      $scope.refresh = state;
    };

    $scope.close_edit = function() {
      if($scope.refresh) {
        $scope.get_data();
      }
      $scope.set_range_filter();
      $scope.refresh =  false;
      $scope.$emit('render');
    };

    $scope.render = function() {
      $scope.$emit('render');
    };

  });

  module.directive('rangefacetChart', function(dashboard, filterSrv) {
    return {
      restrict: 'A',
      template: '<div></div>',
      link: function(scope, elem) {

        // Receive render events
        scope.$on('render',function(){
          render_panel();
        });

        scope.set_range_filter();
        // Re-render if the window is resized
        angular.element(window).bind('resize', function(){
          render_panel();
        });

        // Function for rendering panel
        function render_panel() {
          // IE doesn't work without this
          elem.css({height:scope.panel.height || scope.row.height});

          // Populate from the query service
          try {
            _.each(scope.data, function(series) {
              series.label = series.info.alias;
              series.color = series.info.color;
            });
          } catch(e) {return;}

          // Set barwidth based on specified interval
          var barwidth = scope.panel.maximum-scope.panel.minimum;
          var count = scope.range_count > 15 ? scope.range_count : 15;
          var stack = scope.panel.stack ? true : null;
          var facet_range = scope.get_facet_range();
          // Populate element
          try {
            var options = {
              legend: { show: false },
              series: {
                stackpercent: scope.panel.stack ? scope.panel.percentage : false,
                stack: scope.panel.percentage ? null : stack,
                lines:  {
                  show: scope.panel.lines,
                  // Silly, but fixes bug in stacked percentages
                  fill: scope.panel.fill === 0 ? 0.001 : scope.panel.fill/10,
                  lineWidth: scope.panel.linewidth,
                  steps: false
                },
                bars:   {
                  show: scope.panel.bars,
                  fill: 1,
                  barWidth: barwidth/(9*count),
                  zero: false,
                  lineWidth: 0
                },
                points: {
                  show: scope.panel.points,
                  fill: 1,
                  fillColor: false,
                  radius: 5
                },
                shadowSize: 1
              },
              yaxis: {
                show: scope.panel['y-axis'],
                min: 0,
                max: scope.panel.percentage && scope.panel.stack ? 100 : null,
              },
              xaxis: {
                show: scope.panel['x-axis'],
                min: facet_range.from - 1,
                max: facet_range.to + 1,
              },
              grid: {
                backgroundColor: null,
                borderWidth: 0,
                hoverable: true,
                color: '#c8c8c8'
              }
            };

            if(scope.panel.interactive) {
              options.selection = { mode: "x", color: '#666' };
            }

            // when rendering stacked bars, we need to ensure each point that has data is zero-filled
            // so that the stacking happens in the proper order
            var required_times = [];
            if (scope.data.length > 1) {
              required_times = Array.prototype.concat.apply([], _.map(scope.data, function (query) {
                return query.time_series.getOrderedTimes();
              }));
              required_times = _.uniq(required_times.sort(function (a, b) {
                // decending numeric sort
                return a-b;
              }), true);
            }

            for (var i = 0; i < scope.data.length; i++) {
              scope.data[i].data = scope.data[i].time_series.getFlotPairs(required_times);
            }

            // ISSUE: SOL-76
            // If 'lines_smooth' is enabled, loop through $scope.data[] and remove zero filled entries.
            // Without zero values, the line chart will appear smooth as SiLK ;-)
            if (scope.panel.lines_smooth) {
              for (var i=0; i < scope.data.length; i++) {
                var new_data = [];
                for (var j=0; j < scope.data[i].data.length; j++) {
                  // if value of the timestamp !== 0, then add it to new_data
                  if (scope.data[i].data[j][1] !== 0) {
                    new_data.push(scope.data[i].data[j]);
                  }
                }
                scope.data[i].data = new_data;
              }
            }
            
            if (DEBUG) { console.debug('RangeFacet:\n\tflot options = ',options,'\n\tscope.data = ',scope.data); }

            scope.plot = $.plot(elem, scope.data, options);
          } catch(e) {
            // TODO: Need to fix bug => "Invalid dimensions for plot, width = 0, height = 200"
            console.log(e);
          }
        }

        function time_format(interval) {
          var _int = kbn.interval_to_seconds(interval);
          if(_int >= 2628000) {
            return "%m/%y";
          }
          if(_int >= 86400) {
            return "%m/%d/%y";
          }
          if(_int >= 60) {
            return "%H:%M<br>%m/%d";
          }

          return "%H:%M:%S";
        }

        var $tooltip = $('<div>');
        elem.bind("plothover", function (event, pos, item) {
          var group, value;
          if (item) {
            if (item.series.info.alias || scope.panel.tooltip.query_as_alias) {
              group = '<small style="font-size:0.9em;">' +
                '<i class="icon-circle" style="color:'+item.series.color+';"></i>' + ' ' +
                (item.series.info.alias || item.series.info.query)+
              '</small><br>';
            } else {
              group = kbn.query_color_dot(item.series.color, 15) + ' ';
            }
            if (scope.panel.stack && scope.panel.tooltip.value_type === 'individual')  {
              value = item.datapoint[1] - item.datapoint[2];
            } else {
              value = item.datapoint[1];
            }
            $tooltip
              .html(
                group + value + " [" + item.datapoint[0]+" - "+ (item.datapoint[0] + (scope.panel.gap-1)) +"]"
              )
              .place_tt(pos.pageX, pos.pageY);
          } else {
            $tooltip.detach();
          }
        });

        elem.bind("plotselected", function (event, ranges) {
          filterSrv.removeByType('range');
          var from = parseInt(ranges.xaxis.from);
          var to = parseInt(ranges.xaxis.to);
          filterSrv.set({
            type  : 'range',
            from  : from,
            to    : to,
            field : scope.panel.range_field
          });
          scope.set_configrations(from,to)
          dashboard.refresh();
        });
      }
    };
  });

});
